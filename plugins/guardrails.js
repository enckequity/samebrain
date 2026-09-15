// samebrain guardrails plugin for opencode.
//
// Mechanizes the non-negotiable rules that are otherwise prose-only in the global
// guardrails, so they hold even when a model forgets them. The before-hook throws,
// which makes opencode cancel the tool call and show the model the reason.
//
//   - conventional commits, no AI attribution, no hook-skipping / empty commits
//   - no force-push, no git config rewrites
//   - no staging of secret files (explicit paths and broad `add -A`)
//
// Env knobs:
//   SAMEBRAIN_GUARDRAILS=0   load no checks
//
// Pure decisioning lives in evaluateCommand/secretPathInStatus; the default export
// stays thin so the whole plugin can be driven by the test suite without opencode.

import { execFileSync } from "node:child_process"

const DISABLED = process.env.SAMEBRAIN_GUARDRAILS === "0"

const CONVENTIONAL = /^(feat|fix|refactor|docs|test|chore|perf|ci|build|style|revert|mem|memory|render|release)(\([^)]+\))?!?: .+/
const AI_ATTRIBUTION = /(co-authored-by:.*(claude|gpt|copilot|codex|cursor|opencode|kimi|devin|\bai\b)|generated with .*(claude|opencode|codex|cursor|kimi)|\u{1F916})/iu
// A path component that looks like a credential. Kept deliberately narrow so a
// false positive doesn't block an unrelated `git add`.
const SECRET_PATH = /(^|\/)(\.env(\.[^/]+)?|[^/]*\.env|secrets?\.env|\.netrc|credentials|id_rsa[^/]*|id_ed25519[^/]*|[^/]*\.(pem|key|p12|pfx|keystore))$/i

const reason = (text) => ({ block: true, reason: text })

// Split a command into segments (top-level `&& || ; | newline`) as token arrays,
// honoring single/double quotes so a quoted multi-line commit message stays intact.
function segmentTokens(command) {
  const segments = []
  let tokens = []
  let cur = ""
  let quote = null
  const flushTok = () => { if (cur) { tokens.push(cur); cur = "" } }
  const flushSeg = () => { flushTok(); if (tokens.length) segments.push(tokens); tokens = [] }
  const s = String(command ?? "")
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[(i += 1)]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === "\n" || c === ";") { flushSeg(); continue }
    if (c === "&" || c === "|") { if (s[i + 1] === c) i += 1; flushSeg(); continue }
    if (/\s/.test(c)) { flushTok(); continue }
    cur += c
  }
  flushSeg()
  return segments
}

function gitSubcommand(tokens) {
  const i = tokens.indexOf("git")
  if (i === -1) return null
  // skip global flags between `git` and the subcommand (e.g. -C <dir>)
  let j = i + 1
  while (j < tokens.length && tokens[j].startsWith("-")) {
    j += tokens[j] === "-C" || tokens[j] === "--git-dir" || tokens[j] === "--work-tree" ? 2 : 1
  }
  if (j >= tokens.length) return null
  return { sub: tokens[j], args: tokens.slice(j + 1) }
}

function commitMessages(args) {
  const messages = []
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i]
    if (t === "-m" || t === "--message") { if (i + 1 < args.length) messages.push(args[(i += 1)]) }
    else if (t.startsWith("--message=")) messages.push(t.slice("--message=".length))
    else if (/^-[a-zA-Z]*m$/.test(t)) { if (i + 1 < args.length) messages.push(args[(i += 1)]) }
  }
  return messages
}

function addPaths(args) {
  return args.filter((a) => !a.startsWith("-") && a !== ":" && a !== ".")
}

function isBroadAdd(args) {
  return args.some((a) => a === "." || a === "-A" || a === "--all" || a === ":")
}

// The pure rules. Returns null (allowed) or { block, reason }.
function evaluateCommand(command) {
  for (const tokens of segmentTokens(command)) {
    const g = gitSubcommand(tokens)
    if (!g) continue

    if (g.sub === "commit") {
      if (g.args.some((a) => a === "--no-verify" || a === "-n" || a === "--allow-empty" || a === "--interactive")) {
        return reason("Blocked: do not skip hooks, create empty commits, or commit interactively. Fix the failure and commit normally.")
      }
      const messages = commitMessages(g.args)
      const header = (messages[0] ?? "").split("\n")[0].trim()
      if (messages.length) {
        if (AI_ATTRIBUTION.test(messages.join("\n"))) return reason("Blocked: no AI attribution lines. Write a conventional commit subject with no co-author or generated-with trailer.")
        if (header && !CONVENTIONAL.test(header)) {
          return reason("Blocked: commit message must be conventional — `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci, build, style, revert).")
        }
      }
    }

    if (g.sub === "push") {
      if (g.args.some((a) => a === "-f" || a === "--force" || a.startsWith("--force"))) {
        return reason("Blocked: force-push rewrites shared history. Push a normal commit, or ask the user before rewriting.")
      }
    }

    if (g.sub === "config") {
      const read = g.args.some((a) => a === "--get" || a === "--get-all" || a === "--get-regexp" || a === "--list" || a === "-l")
      const hasValue = g.args.filter((a) => !a.startsWith("-")).length >= 1
      if (!read && hasValue) return reason("Blocked: do not modify git config. Set repo-scoped behavior with command flags or ask the user.")
    }

    if (g.sub === "add") {
      const offender = addPaths(g.args).find((p) => SECRET_PATH.test(p))
      if (offender) return reason(`Blocked: refusing to stage a credential-looking path (${offender}). Keep secrets in the environment or a secret manager, never in git.`)
    }
  }
  return null
}

// Any credential-looking path in `git status --porcelain` (used to catch `git add -A`).
function secretPathInStatus(porcelain) {
  return String(porcelain ?? "")
    .split("\n")
    .map((l) => l.slice(3).trim().replace(/^".*?-> /, "").replace(/"/g, ""))
    .find((p) => SECRET_PATH.test(p)) ?? null
}

function broadAddWouldStageSecret(command, cwd) {
  for (const tokens of segmentTokens(command)) {
    const g = gitSubcommand(tokens)
    if (!g || g.sub !== "add" || !isBroadAdd(g.args)) continue
    let out = ""
    try {
      out = execFileSync("git", ["status", "--porcelain"], { cwd, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString()
    } catch {
      return null
    }
    const offender = secretPathInStatus(out)
    if (offender) return offender
  }
  return null
}

async function guardrails({ directory }) {
  if (DISABLED) return {}
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = output?.args?.command
      if (typeof command !== "string" || !command) return

      const hit = evaluateCommand(command)
      if (hit) throw new Error(hit.reason)

      const cwd = output?.args?.workdir ?? directory
      if (!cwd) return
      const offender = broadAddWouldStageSecret(command, cwd)
      if (offender) {
        throw new Error(`Blocked: \`git add\` would stage a credential-looking path (${offender}). Keep secrets out of git and add specific files instead.`)
      }
    },
  }
}

// Exposed for the test suite without becoming a second plugin export.
guardrails.evaluateCommand = evaluateCommand
guardrails.secretPathInStatus = secretPathInStatus

export default guardrails