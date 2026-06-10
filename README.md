# samebrain

[![ci](https://github.com/enckequity/samebrain/actions/workflows/ci.yml/badge.svg)](https://github.com/enckequity/samebrain/actions/workflows/ci.yml)

**One brain for every AI coding agent — Claude Code, Codex, Cursor — on every machine.**

If you run more than one AI coding agent, you know the drift: each agent has its own global rules, its own MCP config, its own (lack of) memory. Fix something in Claude Code, and Codex never hears about it. Teach an agent an infra gotcha on your desktop, and the same agent on your laptop relearns it the hard way. Two agents pick up the same task and collide in one checkout.

samebrain makes one git repo the single source of truth for all of it:

```
global/guardrails.md  ─┐
global/coordination.md ├─► node bin/render.mjs ──► ~/.codex/AGENTS.md
global/addenda/*.md   ─┤      (idempotent,         ~/.claude/CLAUDE.md
global/mcp.json       ─┘       deterministic)      ~/.cursor/mcp.json
                                                   ~/.claude.json  (mcpServers, merge-only)
                                                   session hooks in all 3 agents

memory/MEMORY.md  ◄── every agent reads at session start (hooks) and appends facts;
memory/topics/*.md     git syncs it across machines (recall pulls, sync pushes)
```

No daemon. No vector database. No LLM API calls. No dependencies beyond `node` and `git`. ~300 lines of code you can read in ten minutes.

## Quickstart

1. Click **Use this template** → create a **private** repo (your config and memory are yours).
2. Clone and render:

```bash
gh repo clone <you>/<your-repo> ~/samebrain
cd ~/samebrain && node bin/render.mjs
```

3. Edit `global/*.md` to taste, add your MCP servers to `global/mcp.json`, re-run `node bin/render.mjs`. Done — every agent on this machine now shares the same rules, tools, and memory.

On every other machine: clone the same repo, run the same command.

## What gets synced

| Surface | Claude Code | Codex | Cursor |
|---|---|---|---|
| Global instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | per-repo `.cursor/rules` (see limits) |
| MCP servers | `~/.claude.json` (merge-only) | unmanaged by default¹ | `~/.cursor/mcp.json` (owned) |
| Memory recall (session start) | `SessionStart` hook | `SessionStart` hook | `sessionStart` hook |
| Memory persist (session end) | `SessionEnd` hook | `Stop` hook | `stop` hook |

¹ Codex loads every configured MCP server into memory; keeping `config.toml` lean is deliberate. Add a renderer target if you want it managed.

Also covered, automatically detected (rendered only if the agent's directory exists):

- **Gemini CLI** → `~/.gemini/GEMINI.md`
- **GitHub Copilot CLI** → `~/.copilot/instructions/samebrain.instructions.md`
- **opencode** → nothing to render: it reads `~/.claude/CLAUDE.md` globally by default, so it inherits samebrain for free.

Gemini/Copilot don't get memory hooks yet — their rendered instructions carry a memory-bootstrap line telling the agent to read the shared index at session start.

**Rendered files carry a marker comment** — edit the canonical files in `global/`, never the rendered ones. `node bin/render.mjs --check` reports drift without writing. First render backs up anything it replaces to `backups/` (gitignored).

## Shared memory: git, not a memory server

Every session of every agent starts with the contents of `memory/MEMORY.md` injected into context (after a fast, fail-silent `git pull`). The instructions rendered into every agent tell it to append durable facts — one line in the index, detail in `memory/topics/*.md`. At session end, a hook commits and pushes. Offline? Both hooks fail silently and reconcile on the next pull.

Why this beats an MCP memory server:

- **Unconditional recall.** The #1 failure mode of tool-based memory is the agent never calling the tool. A hook injects memory every time, no model judgment involved.
- **~1–2k tokens per session** for a disciplined index, vs 10–50k of tool schemas an MCP memory server adds to *every* request.
- **Zero infrastructure.** No embedding API, no vector store, no daemon eating RAM. Git is the sync protocol, the history, and the backup.
- **You own it.** Plain markdown, versioned, greppable, editable, portable.

Discipline: one line per fact, cap the index at ~120 lines, prune stale facts. The index is a per-session token tax — keep it cheap.

## smartloop: a token-frugal loop for Claude Code

`/smartloop <task>` runs any task as a self-pacing loop with durable state
(`~/.smartloop/<slug>/state.md`, override with `SMARTLOOP_DIR`): contract-first
success criteria, tiered verification, subagent context firewalls, cache-aware
wake pacing, and park/resume across rate limits. Two liveness hooks make silent
loop death impossible — a Stop dead-man check blocks ending a session that owns
a run with no scheduled wake, and a session-start sweep surfaces orphaned or
parked runs (printing nothing when there are none). Claude Code only; design
rationale in `docs/plans/2026-06-10-smartloop-design.md`. The skill ships in
`skills/smartloop/` and renders to `~/.claude/skills/` like every other target.

Two lifecycle notes: runs with status `blocked:*` keep appearing at session
start until you mark them `done` or delete `~/.smartloop/<slug>/` — that is
"needs attention" semantics doing its job. And removing a skill from `skills/`
does not delete its published copy under `~/.claude/skills/` (the engine merges,
never deletes) — remove the published directory by hand if you retire one.

## Secrets

String values in `global/mcp.json` support two reference forms, resolved at render time:

- `${ENV_VAR}` — from the environment, falling back to a gitignored `secrets.env` (KEY=VALUE lines) at the repo root
- `op://vault/item/field` — via the [1Password CLI](https://developer.1password.com/docs/cli/)

Rendered agent configs get literal values (agents can't expand references); the repo never holds a raw secret — even private forks shouldn't. Unresolvable references fail the render loudly, naming the variable. `secrets.env` exists for machines without a secret-manager CLI: rendered configs already hold resolved values locally, so a local env file adds no new exposure class — copy it once per machine and keep the canonical copy in your secret manager.

## Multi-agent coordination

`global/coordination.md` renders into every agent's instructions, so all of them follow one protocol: claim a GitHub issue (label `agent:claude` / `agent:codex` / `agent:cursor`) before non-trivial work, always work in a dedicated `git worktree`, branch under your namespace (`claude/*`, `codex/*`, `cursor/*`), integrate via PR only. The PR queue serializes conflicts; `git reflog` recovers from branch flips.

## Cost: zero, by design

- **No LLM API calls anywhere.** Rendering is deterministic string assembly; memory is file injection. Your agents run entirely on the subscriptions you already pay for (Claude, ChatGPT/Codex, Cursor).
- **Token-frugal.** Hooks instead of MCP tools; a capped memory index instead of schema bloat; one set of instructions instead of three drifting copies.
- **No services.** Nothing to host, nothing metered, nothing that bills.

## Updating the engine

Your repo is an instance of this template. To pull engine improvements:

```bash
git remote add upstream https://github.com/enckequity/samebrain.git   # once
git pull upstream main                                                # whenever
```

You edit `global/` and `memory/`; the template only evolves `bin/`, `hooks/`, and docs — so pulls merge cleanly.

Optional: auto-render after every pull, so config changes land the moment they arrive:

```bash
git config core.hooksPath .githooks   # once per clone
```

Tests live in `test/run.mjs` (no framework, no deps) and run on Linux/macOS/Windows in CI — `node test/run.mjs` locally before a PR.

## Honest limits

Some surfaces are vendor-locked and cannot be file-synced; know them rather than fight them:

- **Cursor global User Rules** live only in the IDE's settings database (no file API). Keep them as a paste of `guardrails.md`; per-repo `.cursor/rules/*.mdc` carry the rest.
- **claude.ai OAuth connectors and Claude Code plugins** are account/installation state, not files.
- **Per-repo configs** (project AGENTS.md / CLAUDE.md / `.cursor/rules`) belong in each project's repo — samebrain handles the global layer only.

## Design notes

- **Own renderer instead of an existing sync tool**: as of mid-2026 no tool rendered global rules + MCP + hooks across all three agents (the closest, rulesync, covers global rules for Claude Code/Copilot/opencode only). 150 lines was cheaper than the gap.
- **Markdown-in-git memory instead of mem0/OpenMemory**: OpenMemory is sunset; hosted memory adds a service dependency, latency, and token overhead for worse recall guarantees at personal scale.
- **Merge-only where agents own state**: `~/.claude.json` and hook files are merged key-by-key, never overwritten — samebrain coexists with whatever else manages those files.

## License

MIT
