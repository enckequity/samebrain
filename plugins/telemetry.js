// samebrain token/cost telemetry for opencode.
//
// opencode reports per-assistant-message `cost` and `tokens`. This plugin keeps
// the latest reading per message and, on each session idle, appends a cumulative
// snapshot to telemetry/<machine>/opencode-costs.jsonl — a file the existing
// session sync already commits. Consumers take the max per session_id as the
// final total. Nothing is written unless a snapshot actually grew.
//
// Env knobs:
//   SAMEBRAIN_TELEMETRY=0   load nothing
//   SAMEBRAIN_DIR           repo root (default {{REPO}})

import { appendFileSync, mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { join, resolve } from "node:path"

const ROOT = resolve(process.env.SAMEBRAIN_DIR ?? "{{REPO}}")
const DISABLED = process.env.SAMEBRAIN_TELEMETRY === "0"
const MACHINE = hostname().split(".")[0]

function aggregate(messages) {
  const acc = {
    cost: 0,
    messages: 0,
    models: new Set(),
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
  }
  for (const m of messages.values()) {
    acc.cost += m.cost
    acc.messages += 1
    if (m.model) acc.models.add(m.model)
    const t = m.tokens ?? {}
    acc.tokens.input += t.input ?? 0
    acc.tokens.output += t.output ?? 0
    acc.tokens.reasoning += t.reasoning ?? 0
    acc.tokens.cache_read += t.cache?.read ?? 0
    acc.tokens.cache_write += t.cache?.write ?? 0
  }
  return acc
}

function write(sessionID, acc) {
  const now = new Date()
  const dir = join(ROOT, "telemetry", MACHINE)
  const record = {
    ts: now.toISOString(),
    agent: "opencode",
    machine: MACHINE,
    session_id: sessionID,
    cost_usd: Number(acc.cost.toFixed(6)),
    tokens: acc.tokens,
    assistant_messages: acc.messages,
    models: [...acc.models].sort(),
  }
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, "opencode-costs.jsonl"), `${JSON.stringify(record)}\n`)
}

export default async () => {
  if (DISABLED) return {}
  const perSession = new Map()
  const writtenCost = new Map()

  return {
    event: async ({ event }) => {
      const p = event.properties ?? {}

      if (event.type === "message.updated") {
        const info = p.info
        if (!info || info.role !== "assistant" || !info.sessionID || !info.id) return
        let messages = perSession.get(info.sessionID)
        if (!messages) { messages = new Map(); perSession.set(info.sessionID, messages) }
        messages.set(info.id, { cost: info.cost ?? 0, tokens: info.tokens, model: info.modelID })
        return
      }

      if (event.type === "session.idle") {
        const id = p.sessionID
        if (!id) return
        const messages = perSession.get(id)
        if (!messages || messages.size === 0) return
        const acc = aggregate(messages)
        if (writtenCost.has(id) && acc.cost <= writtenCost.get(id)) return
        writtenCost.set(id, acc.cost)
        try { write(id, acc) } catch { /* telemetry is best-effort */ }
        return
      }

      if (event.type === "session.deleted") {
        const id = p.info?.id
        if (!id) return
        perSession.delete(id)
        writtenCost.delete(id)
      }
    },
  }
}