// samebrain memory plugin for opencode.
//
// Gives opencode the same automatic memory lifecycle Claude Code/Codex get from
// samebrain's session hooks, plus lazy retrieval so the index can stay small:
//
//   recall   - once per session, pull + re-render (via hooks/recall.mjs); every model
//              call then carries a BYTE-BOUNDED memory index (plus the Hindsight recall)
//              in the system prompt. The system prompt is rebuilt per request and the
//              first request is often the title generator, so injecting once is not enough.
//   persist  - debounced on session.idle, throttled per session, and forced on
//              session.deleted / plugin dispose: runs hooks/sync.mjs --agent opencode
//              (telemetry record + `mem: session update` commit + push).
//   capture  - autonomous (agent-deck) sessions only: when a reply ends on a terminal marker,
//              retain the transcript to Hindsight once (hooks/opencode-capture.mjs).
//   retrieve - memory_search / memory_read tools for on-demand detail. memory_search asks
//              Hindsight first (bin/memory-search.mjs: repo bank + global bank, bounded
//              timeout) and falls back to BM25 over memory/topics/*.md when Hindsight is
//              unconfigured, unreachable or has nothing.
//   record   - memory_append for a new durable fact; memory_sync to flush now.
//
// Env knobs:
//   SAMEBRAIN_DIR                 repo root (default: this repo, set at render)
//   SAMEBRAIN_DISABLE=1           load nothing
//   SAMEBRAIN_PULL=0              skip recall (no pull/re-render)
//   SAMEBRAIN_PERSIST=0           skip sync/commit/push
//   SAMEBRAIN_CAPTURE=0           skip the end-of-task Hindsight capture
//   SAMEBRAIN_MEMORY_MAX_BYTES    injected index budget (default 14000: the 12KB index cap plus framing)
//   SAMEBRAIN_IDLE_DEBOUNCE_MS    idle settle before persist (default 2500)
//   SAMEBRAIN_PERSIST_THROTTLE_MS min gap between idle persists (default 300000)

import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { tool, type Plugin } from "@opencode-ai/plugin"

const ROOT = resolve(process.env.SAMEBRAIN_DIR ?? "{{REPO}}")
const MEMORY = join(ROOT, "memory")
const INDEX = join(MEMORY, "MEMORY.md")
const TOPICS = join(MEMORY, "topics")
const RECALL = join(ROOT, "hooks", "recall.mjs")
const SYNC = join(ROOT, "hooks", "sync.mjs")
const SEARCH = join(ROOT, "bin", "memory-search.mjs")
const CAPTURE = join(ROOT, "hooks", "opencode-capture.mjs")
const AUTO_CONTINUE = join(ROOT, "hooks", "auto-continue-core.mjs")

const DISABLED = process.env.SAMEBRAIN_DISABLE === "1"
const DO_PULL = process.env.SAMEBRAIN_PULL !== "0"
const DO_PERSIST = process.env.SAMEBRAIN_PERSIST !== "0"
const DO_CAPTURE = process.env.SAMEBRAIN_CAPTURE !== "0"
const MAX_BYTES = Math.max(800, Number.parseInt(process.env.SAMEBRAIN_MEMORY_MAX_BYTES ?? "14000", 10) || 14000)
const IDLE_DEBOUNCE_MS = Number.parseInt(process.env.SAMEBRAIN_IDLE_DEBOUNCE_MS ?? "2500", 10) || 2500
const PERSIST_THROTTLE_MS = Number.parseInt(process.env.SAMEBRAIN_PERSIST_THROTTLE_MS ?? "300000", 10) || 300000

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s).length
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function runStatus(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    let out = ""
    let done = false
    const finish = (code: number | null) => { if (!done) { done = true; res({ code, out }) } }
    let child
    try {
      child = spawn(cmd, args, { cwd: ROOT, env: opts.env, stdio: ["ignore", "pipe", "ignore"] })
    } catch {
      return finish(null)
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* gone */ } finish(null) }, opts.timeoutMs ?? 20000)
    child.stdout?.on("data", (c) => { out += String(c) })
    child.on("close", (code) => { clearTimeout(timer); finish(code) })
    child.on("error", () => { clearTimeout(timer); out = ""; finish(null) })
  })
}

const run = async (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) =>
  (await runStatus(cmd, args, opts)).out

// ---- injected block -------------------------------------------------------------

let blockCache: { key: string; value: string | null } | null = null

function buildBlock(): string | null {
  if (!existsSync(INDEX)) return null
  let raw: string
  let key: string
  try {
    raw = readFileSync(INDEX, "utf8")
    const st = statSync(INDEX)
    key = `${st.mtimeMs}:${st.size}:${MAX_BYTES}`
  } catch {
    return null
  }
  if (blockCache && blockCache.key === key) return blockCache.value

  const lines = raw.split("\n").filter((l) => !l.trim().startsWith("<!--"))
  const source = ROOT.startsWith(homedir()) ? `~${ROOT.slice(homedir().length)}/memory` : `${ROOT}/memory`
  const header = `<shared-agent-memory source="${source.replaceAll("\\", "/")}" detail-files="memory/topics/*.md" tools="memory_search,memory_read,memory_append">`
  const footer = "</shared-agent-memory>"
  const guidance = "\n\nShared cross-agent memory is injected automatically each session. Use `memory_search` to pull detail from memory/topics/*.md, `memory_read` to open one topic, and `memory_append` to record a new durable fact (one line in the index, detail in a topic). Keep the index lean."
  const truncNote = `\n\n[index truncated at ~${MAX_BYTES} bytes — use memory_search for detail; prune stale facts to shrink the per-session tax]`
  // Reserve the fixed text (including the worst-case truncation note) so the whole
  // returned block — not just the index — stays within MAX_BYTES.
  const reserved = bytes(header) + bytes(footer) + bytes(guidance) + bytes(truncNote) + 8
  const budget = Math.max(0, MAX_BYTES - reserved)

  const kept: string[] = []
  let used = 0
  let truncated = false
  for (const l of lines) {
    const b = bytes(`${l}\n`)
    if (used + b > budget) { truncated = true; break }
    kept.push(l)
    used += b
  }
  const tail = truncated ? truncNote : ""
  const value = `${header}\n${kept.join("\n").trim()}\n${tail}${footer}${guidance}`

  blockCache = { key, value }
  return value
}

// ---- retrieval index (BM25 over topics/*.md) ------------------------------------

type Doc = { name: string; lines: string[]; tf: Map<string, number>; len: number }
let searchCache: { sig: string; docs: Doc[]; df: Map<string, number>; avg: number } | null = null

const STOP = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out",
  "day", "get", "has", "him", "his", "how", "its", "new", "now", "old", "see", "two", "way", "who",
  "did", "use", "that", "this", "with", "from", "they", "have", "will", "your", "when", "what", "into",
  "than", "then", "them", "these", "some", "such", "only", "over", "also", "been", "were", "more",
  "most", "much", "many", "very", "just", "like", "about", "after", "before", "because", "while",
  "where", "which", "there", "their", "other", "should", "could", "would", "does", "doing", "done",
  "each", "few", "any", "get", "has", "had", "was", "were", "is", "are", "be", "to", "of", "in",
  "on", "at", "by", "or", "as", "it", "if", "no", "so", "we", "an",
])

function tokenize(text: string): string[] {
  const m = text.toLowerCase().match(/[a-z0-9][a-z0-9_.:/-]{2,}/g)
  return m ? m.filter((t) => !STOP.has(t)) : []
}

function loadSearch() {
  const names = readdirSync(TOPICS)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
  const sig = names.map((n) => { const st = statSync(join(TOPICS, n)); return `${n}:${st.mtimeMs}:${st.size}` }).join("|")
  if (searchCache && searchCache.sig === sig) return searchCache

  const docs: Doc[] = names.map((name) => {
    const content = readFileSync(join(TOPICS, name), "utf8")
    const tf = new Map<string, number>()
    const toks = tokenize(content)
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    return { name, lines: content.split("\n"), tf, len: toks.length }
  })
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const avg = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1)
  searchCache = { sig, docs, df, avg }
  return searchCache
}

// ---- tools ----------------------------------------------------------------------

function searchTopics(query: string, limit?: number): string {
  if (!existsSync(TOPICS)) return "No memory topics directory."
  const { docs, df, avg } = loadSearch()
  const q = [...new Set(tokenize(query))]
  if (!q.length) return "Query had no searchable terms."
  const N = docs.length || 1
  const k1 = 1.2
  const b = 0.75
  const scored = docs
    .map((d) => {
      let s = 0
      for (const t of q) {
        const f = d.tf.get(t)
        if (!f) continue
        const dfi = df.get(t) ?? 0
        const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5))
        s += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.len) / avg))
      }
      return { d, s }
    })
    .filter((r) => r.s > 0)
    .sort((a, c) => c.s - a.s)
    .slice(0, Math.min(limit ?? 5, 10))

  if (!scored.length) return `No topic matched "${query}". Try different keywords, or memory_read MEMORY.md.`
  return scored
    .map(({ d, s }) => {
      const hits = d.lines
        .map((l, i) => ({ l, i, n: q.reduce((a, t) => a + (l.toLowerCase().includes(t) ? 1 : 0), 0) }))
        .filter((h) => h.n > 0)
        .sort((a, c) => c.n - a.n)
        .slice(0, 4)
      const snips = hits.map((h) => `  ${h.i + 1}: ${h.l.trim().slice(0, 240)}`).join("\n")
      return `## ${d.name} (score ${s.toFixed(2)})\n${snips}`
    })
    .join("\n\n")
}

const searchTool = tool({
  description: "Search shared cross-agent memory for a query. Asks Hindsight long-term memory (this repository's bank plus the global bank) first, then falls back to matching lines in memory/topics/*.md. Use before assuming you lack context; then memory_read a topic for full detail.",
  args: {
    query: tool.schema.string().describe("Keywords or a natural-language question"),
    limit: tool.schema.number().optional().describe("Max topics to return from the local fallback (default 5, max 10)"),
  },
  async execute(args, ctx) {
    const { code, out } = await runStatus(process.execPath, [SEARCH, args.query, "--cwd", ctx.directory], { timeoutMs: 15000 })
    if (code === 0 && out.trim()) return `Hindsight memory:\n\n${out.trim()}`
    const local = searchTopics(args.query, args.limit)
    return code === 1 ? `Hindsight had no match; local topics:\n\n${local}` : local
  },
})

const readTool = tool({
  description: "Read a shared-memory file: the index (MEMORY.md) or a topic (memory/topics/<name>.md). Returns line-numbered content.",
  args: {
    file: tool.schema.string().describe("MEMORY.md, or a topic name like 'deploy-notes' or 'deploy-notes.md'"),
    offset: tool.schema.number().optional().describe("Start line (1-based, default 1)"),
    limit: tool.schema.number().optional().describe("Max lines (default 400, max 1000)"),
  },
  async execute(args) {
    const rel = args.file.trim()
    let target: string
    if (rel === "MEMORY.md" || rel === "index") {
      target = INDEX
    } else {
      const name = rel.startsWith("topics/") ? rel.slice("topics/".length) : rel
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) {
        return "Path must be MEMORY.md or a topics/*.md file."
      }
      target = join(TOPICS, name.endsWith(".md") ? name : `${name}.md`)
    }
    const rp = resolve(target)
    if (rp !== resolve(INDEX) && !rp.startsWith(resolve(TOPICS) + sep)) {
      return "Path must be MEMORY.md or a topics/*.md file."
    }
    if (!existsSync(rp)) return `Not found: ${rel}`
    const all = readFileSync(rp, "utf8").split("\n")
    const off = Math.max(1, args.offset ?? 1)
    const lim = Math.min(args.limit ?? 400, 1000)
    const slice = all.slice(off - 1, off - 1 + lim)
    const show = rel === "index" ? "MEMORY.md" : rel
    return `${show} (lines ${off}-${off - 1 + slice.length} of ${all.length})\n${slice
      .map((l, i) => `${off + i}: ${l}`)
      .join("\n")}`
  },
})

const appendTool = tool({
  description: "Record a new durable cross-agent fact. Appends one line to the memory index and, when topic+detail are given, the detail to that topic file. The change is committed and pushed at session end (or use memory_sync now).",
  args: {
    fact: tool.schema.string().describe("One-line fact: infra quirk, account mapping, decision, gotcha (max 400 chars)"),
    topic: tool.schema.string().optional().describe("Topic file name to hold detail, e.g. 'agent-fleet'"),
    detail: tool.schema.string().optional().describe("Verbose detail for the topic file"),
  },
  async execute(args) {
    const fact = args.fact.replace(/\s*\n\s*/g, " ").trim()
    if (!fact) return "Empty fact."
    if (fact.length > 400) return "Fact too long (max 400 chars) — keep the index line tight and put detail in a topic."
    if (!existsSync(MEMORY)) mkdirSync(MEMORY, { recursive: true })
    appendFileSync(INDEX, `- ${fact}\n`)
    let note = "Appended to MEMORY.md."
    if (args.topic && args.detail?.trim()) {
      const raw = args.topic.trim()
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(raw) || raw.includes("..")) {
        return `${note} (topic name invalid — detail not written)`
      }
      const name = raw.endsWith(".md") ? raw : `${raw}.md`
      if (!existsSync(TOPICS)) mkdirSync(TOPICS, { recursive: true })
      const tp = join(TOPICS, name)
      if (!existsSync(tp)) appendFileSync(tp, `# ${name.replace(/\.md$/, "")}\n`)
      appendFileSync(tp, `\n## ${new Date().toISOString().slice(0, 10)}\n\n${args.detail.trim()}\n`)
      note += ` Detail written to topics/${name}.`
    }
    return `${note} Committed and pushed at session end, or run memory_sync now.`
  },
})

const syncTool = tool({
  description: "Commit and push shared memory (and telemetry/leases) to the samebrain git remote right now. Normally runs automatically at session end.",
  args: {},
  async execute(_args, ctx) {
    const out = await run(process.execPath, [SYNC, "--agent", "opencode"], {
      env: { ...process.env, SAMEBRAIN_SESSION_ID: ctx.sessionID, SAMEBRAIN_CWD: ctx.directory },
      timeoutMs: 25000,
    })
    return out.trim() || "Sync attempted (nothing to report — likely offline or no changes)."
  },
})

// ---- plugin ---------------------------------------------------------------------

export const SameBrainMemory: Plugin = async ({ directory, client }) => {
  if (DISABLED) return {}

  const waited = new Set<string>()
  const captured = new Map<string, number>()
  const bootstrapped = new Map<string, Promise<string>>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastPersist = new Map<string, number>()
  let lastSession = "unknown"

  const ensureBootstrap = (id: string) => {
    if (!DO_PULL) return Promise.resolve("")
    let p = bootstrapped.get(id)
    if (!p) {
      p = run(process.execPath, [RECALL], { env: { ...process.env, SAMEBRAIN_CWD: directory }, timeoutMs: 8000 })
      bootstrapped.set(id, p)
    }
    return p
  }

  const persist = (id: string, cwd: string) => {
    if (!DO_PERSIST) return Promise.resolve("")
    lastPersist.set(id, Date.now())
    return run(process.execPath, [SYNC, "--agent", "opencode"], {
      env: { ...process.env, SAMEBRAIN_SESSION_ID: id, SAMEBRAIN_CWD: cwd },
      timeoutMs: 25000,
    })
  }

  // Cheap guard so an idle pause only syncs when memory actually changed.
  const dirty = async () => {
    const out = await run("git", ["status", "--porcelain", "--", "memory", "telemetry", "coordination/leases"], { timeoutMs: 5000 })
    return out.trim().length > 0
  }

  const props = (event: unknown) => (event as { properties?: any }).properties ?? {}

  // One write per finished task: nudged (non-terminal) stops never capture, and an unchanged
  // transcript is not re-sent. Fire-and-forget; memory must never break the session.
  const capture = async (id: string) => {
    try {
      const core = await import(pathToFileURL(AUTO_CONTINUE).href)
      if (!DO_CAPTURE || !core.enabled()) return
      const session = await client.session.get({ path: { id } })
      if (session.data?.parentID) return
      const messages = (await client.session.messages({ path: { id } })).data ?? []
      const cap = await import(pathToFileURL(CAPTURE).href)
      if (!core.isTerminal(cap.lastAssistantText(messages))) return
      const turns = cap.opencodeTurns(messages)
      if (captured.get(id) === turns.length) return
      captured.set(id, turns.length)
      const res = await cap.captureSession({ root: ROOT, cwd: session.data?.directory ?? directory, sessionId: id, turns })
      if (!res.ok && !res.skipped) captured.delete(id)
    } catch (err) {
      await client.app.log({ body: { service: "samebrain-memory", level: "warn", message: `capture failed: ${err}` } }).catch(() => {})
    }
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      const id = input.sessionID ?? "default"
      // Only the first call waits for recall; later calls pick it up once it has landed.
      const wait = waited.has(id) ? 0 : 3000
      waited.add(id)
      const recalled = await Promise.race([ensureBootstrap(id), sleep(wait).then(() => "")])
      const block = buildBlock()
      if (block) output.system.push(block)
      // recall.mjs appends a bounded Hindsight recall for this repo when configured.
      const hindsight = recalled.match(/<hindsight_memories[\s\S]*<\/hindsight_memories>/)?.[0]
      if (hindsight) output.system.push(hindsight)
    },

    "experimental.session.compacting": async (_input, output) => {
      const block = buildBlock()
      if (block) output.context.push(block)
    },

    event: async ({ event }) => {
      const p = props(event)
      if (event.type === "session.created") {
        const id: string | undefined = p.info?.id
        if (id) { lastSession = id; ensureBootstrap(id) }
        return
      }
      if (event.type === "session.idle") {
        const id: string | undefined = p.sessionID
        if (!id) return
        lastSession = id
        const prev = idleTimers.get(id)
        if (prev) clearTimeout(prev)
        idleTimers.set(id, setTimeout(async () => {
          idleTimers.delete(id)
          capture(id)
          if (Date.now() - (lastPersist.get(id) ?? 0) < PERSIST_THROTTLE_MS) return
          if (!(await dirty())) return
          persist(id, directory)
        }, IDLE_DEBOUNCE_MS))
        return
      }
      if (event.type === "session.deleted") {
        const id: string | undefined = p.info?.id
        if (!id) return
        const prev = idleTimers.get(id)
        if (prev) { clearTimeout(prev); idleTimers.delete(id) }
        await capture(id)
        await persist(id, p.info?.directory ?? directory)
        waited.delete(id)
        captured.delete(id)
        bootstrapped.delete(id)
        lastPersist.delete(id)
      }
    },

    dispose: async () => {
      for (const t of idleTimers.values()) clearTimeout(t)
      // A task that finished inside the idle debounce must still be captured before exit.
      await Promise.all([...idleTimers.keys()].map(capture))
      idleTimers.clear()
      if (lastSession !== "unknown") await persist(lastSession, directory)
    },

    tool: {
      memory_search: searchTool,
      memory_read: readTool,
      memory_append: appendTool,
      memory_sync: syncTool,
    },
  }
}
