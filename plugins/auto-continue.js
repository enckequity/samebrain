// samebrain auto-continue for opencode (contract in hooks/auto-continue-core.mjs).
//
// When a top-level session goes idle without a terminal marker in its last reply,
// send a nudge prompt so the run keeps going. Bounded per human prompt; skips
// subagent sessions, user aborts, and errored turns; the blocking question tool is denied.
// No-op outside autonomous sessions.

import { CONTRACT, MAX, QUESTION_DENIED, QUESTION_TOOLS, enabled, isTerminal, nudge } from "{{REPO}}/hooks/auto-continue-core.mjs"

export default async ({ client }) => {
  if (!enabled()) return {}
  const max = MAX()
  const counts = new Map()
  const nudging = new Set()
  const aborted = new Set()

  const lastAssistant = async (id) => {
    const res = await client.session.messages({ path: { id } })
    const messages = res.data ?? []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const { info, parts } = messages[i]
      if (info.role !== "assistant") continue
      return { error: info.error, text: (parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n") }
    }
    return null
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(CONTRACT)
    },

    "tool.execute.before": async (input) => {
      if (QUESTION_TOOLS.has(input.tool)) throw new Error(QUESTION_DENIED)
    },

    "chat.message": async (input) => {
      // Our own nudge arrives here too; only a human prompt resets the budget.
      if (nudging.delete(input.sessionID)) return
      counts.delete(input.sessionID)
    },

    event: async ({ event }) => {
      const p = event.properties ?? {}
      if (event.type === "session.error" && p.error?.name === "MessageAbortedError" && p.sessionID) {
        aborted.add(p.sessionID)
        return
      }
      if (event.type !== "session.idle" || !p.sessionID) return
      const id = p.sessionID
      if (aborted.delete(id)) return
      // A nudge that never reached chat.message failed server-side; do not stack another.
      if (nudging.delete(id)) return
      try {
        const session = await client.session.get({ path: { id } })
        if (session.data?.parentID) return
        const last = await lastAssistant(id)
        if (!last || last.error || isTerminal(last.text)) {
          counts.delete(id)
          return
        }
        const n = (counts.get(id) ?? 0) + 1
        if (n > max) return
        counts.set(id, n)
        nudging.add(id)
        const res = await client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text: nudge(n, max) }] } })
        if (res.error) throw new Error(JSON.stringify(res.error))
      } catch (err) {
        nudging.delete(id) // a failed nudge leaves the session idle; record why
        await client.app.log({ body: { service: "auto-continue", level: "warn", message: String(err) } }).catch(() => {})
      }
    },
  }
}
