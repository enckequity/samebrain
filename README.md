# samebrain

[![ci](https://github.com/enckequity/samebrain/actions/workflows/ci.yml/badge.svg)](https://github.com/enckequity/samebrain/actions/workflows/ci.yml)

**One brain for every AI coding agent — Claude Code, Codex, Cursor — on every machine.**

Teach Claude Code something, and Codex never hears about it. Your laptop's agents don't know what your desktop's agents learned this morning. Every agent keeps its own rules, its own tool config, its own amnesia.

samebrain fixes that with one git repo:

- 📋 **One set of rules** — written once, rendered to every agent's native format
- 🧠 **One shared memory** — every agent reads it when a session starts, saves to it when it ends, and git syncs it between your machines
- 🔌 **One tool (MCP) config** — with secrets kept out of the repo

No servers. No API costs. Nothing to install beyond [Node.js](https://nodejs.org) and [git](https://git-scm.com). ~300 lines of code you can read in ten minutes.

## Setup — 3 steps, about 2 minutes

**1.** Click the green **Use this template** button at the top of this page → create the repo as **Private** (your rules and memory are yours).

**2.** Clone your new repo (swap in your username and repo name):

```bash
git clone https://github.com/YOURNAME/YOURREPO ~/samebrain
```

**3.** Run setup:

```bash
cd ~/samebrain
node bin/setup.mjs
```

That's it. Every AI coding agent on this computer now shares the same rules, tools, and memory.

**Another computer?** Repeat steps 2–3 there. Git keeps them in sync.

## Make it yours

Edit these files, then run `node bin/render.mjs` to apply:

| File | What it is |
|---|---|
| `global/guardrails.md` | Your rules for every agent, in plain English |
| `global/coordination.md` | How multiple agents avoid stepping on each other |
| `global/mcp.json` | The MCP servers (tools) your agents can use |
| `global/addenda/*.md` | Extra instructions, one topic per file |
| `global/cursor-user-rules.md` | Paste source for Cursor's global User Rules (render nags on drift) |
| `skills/*/SKILL.md` | Skills, rendered to every agent (`targets:` frontmatter narrows the audience) |
| `memory/MEMORY.md` | Shared memory — your agents maintain this themselves |

Always edit these files — never the rendered copies (those carry a "generated" marker and get overwritten).

## How it works

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

Everything below is detail — click to expand.

<details>
<summary><strong>What gets synced, per agent</strong></summary>

| Surface | Claude Code | Codex | Cursor |
|---|---|---|---|
| Global instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | per-repo `.cursor/rules` (see limits) |
| MCP servers | `~/.claude.json` (merge-only) | `~/.codex/config.toml` (opt-in¹, merge-only) | `~/.cursor/mcp.json` (owned) |
| Skills | `~/.claude/skills/*` | `~/.codex/prompts/*` | `~/.cursor/skills/*` |
| Memory recall (session start) | `SessionStart` hook | `SessionStart` hook | `sessionStart` hook |
| Memory persist + telemetry (session end) | `SessionEnd` hook | `Stop` hook | `stop` hook |

¹ Codex loads every configured MCP server into memory; keeping `config.toml` lean is deliberate. Only servers that list `"codex"` in `targets` are rendered there.

Also covered, automatically detected (rendered only if the agent's directory exists):

- **Gemini CLI** → `~/.gemini/GEMINI.md`
- **GitHub Copilot CLI** → `~/.copilot/instructions/samebrain.instructions.md`
- **opencode** → `~/.config/opencode/AGENTS.md` (it also reads `~/.claude/CLAUDE.md` by default, but an explicit file survives that default changing)
- **Factory Droid** → `~/.factory/AGENTS.md`
- **Pi** → `~/.pi/AGENTS.md`

These detection-gated agents don't get memory hooks yet (their harnesses don't expose them) — their rendered instructions carry a memory-bootstrap line telling the agent to read the shared index at session start.

`node bin/render.mjs --check` reports drift without writing anything. The first render backs up anything it replaces to `backups/` (gitignored).

</details>

<details>
<summary><strong>Shared memory: why git instead of a memory server</strong></summary>

Every session of every agent starts with the contents of `memory/MEMORY.md` injected into context (after a fast, fail-silent `git pull`). The instructions rendered into every agent tell it to append durable facts — one line in the index, detail in `memory/topics/*.md`. At session end, a hook commits and pushes. Offline? Both hooks fail silently and reconcile on the next pull.

Why this beats an MCP memory server:

- **Unconditional recall.** The #1 failure mode of tool-based memory is the agent never calling the tool. A hook injects memory every time, no model judgment involved.
- **~1–2k tokens per session** for a disciplined index, vs 10–50k of tool schemas an MCP memory server adds to *every* request.
- **Zero infrastructure.** No embedding API, no vector store, no daemon eating RAM. Git is the sync protocol, the history, and the backup.
- **You own it.** Plain markdown, versioned, greppable, editable, portable.

Discipline: one line per fact, cap the index at ~120 lines, prune stale facts. The index is a per-session token tax — keep it cheap. (The recall hook warns the agent automatically when the index goes over the cap, and the `/memory-gc` skill walks any agent through deduping, rolling detail into topics, and pruning — proposing a diff, never committing it.)

</details>

<details>
<summary><strong>smartloop: a token-frugal loop for Claude Code</strong></summary>

`/smartloop <task>` runs any task as a self-pacing loop with durable state
(`~/.smartloop/<slug>/state.md`, override with `SMARTLOOP_DIR`): contract-first
success criteria, tiered verification, subagent context firewalls, cache-aware
wake pacing, and park/resume across rate limits. Two liveness hooks make silent
loop death impossible — a Stop dead-man check blocks ending a session that owns
a run with no scheduled wake, and a session-start sweep surfaces orphaned or
parked runs (printing nothing when there are none). Agent-neutral since v5: the
skill and both liveness hooks render to Claude Code, Codex, and Cursor, with an
adapter table mapping each harness's session id and wake primitives (agents
without scheduled wakes run park-only). `/smartloop portfolio` drains every
non-done run under one quota, cheapest rehydrate first. Design rationale in
`docs/plans/2026-06-10-smartloop-design.md`. The skill ships in
`skills/smartloop/` and renders like every other target.

Two lifecycle notes: runs with status `blocked:*` keep appearing at session
start until you mark them `done` or delete `~/.smartloop/<slug>/` — that is
"needs attention" semantics doing its job. And removing a skill from `skills/`
does not delete its published copy under `~/.claude/skills/` (the engine merges,
never deletes) — remove the published directory by hand if you retire one.

</details>

<details>
<summary><strong>Session telemetry</strong></summary>

The session-end sync hook appends one JSONL record per session to
`telemetry/<machine>/<YYYY-MM>.jsonl` — timestamp, agent, machine, session id, a hash of the
working directory (never the raw path), and duration where the agent provides it. Records sync
between machines with the same git push/pull as memory. No tokens are spent and no service is
involved; it's a file append.

This is the raw material for dashboards, eval datasets, and (later) tuning — and it stays in
*your* repo. The public template ships `telemetry/` empty; your instance commits its own data,
which is one more reason instances should be private. Hygiene: render warns when the current
month exceeds 1MB; `node bin/render.mjs --gc` rolls months older than 3 into one-line summaries
in `archive.jsonl`. smartloop runs add a summary record per finished run (`smartloop-runs.jsonl`).

</details>

<details>
<summary><strong>Dashboards, evals, fleet status — local, zero services</strong></summary>

Everything reads the files already in your repo; nothing is hosted, nothing phones home:

- `node bin/dashboard.mjs` — writes a static `dashboard.html` (gitignored): sessions per month
  per machine/agent, smartloop run table with verdicts, memory index health. Open it in a browser.
- `node bin/export.mjs --format deepeval|openai-evals|text [--out file]` — exports the smartloop
  trace corpus as an eval dataset (the same formats OpenSync exports, so tooling interoperates).
  When a run's state file still exists, its Contract goal becomes the sample input.
- `node bin/status.mjs` — one-screen fleet view: machines seen, sessions this month, last git
  sync per machine, smartloop run tallies, coordination leases.

Prefer hosted dashboards? `node bin/setup.mjs --opensync` prints install steps for the
[OpenSync](https://opensync.dev) sync plugins — an optional adapter, never a dependency.

smartloop runs can also park on one machine and resume on another: set `SMARTLOOP_SYNC_REMOTE`
to a private git remote and the state dir syncs at park/resume boundaries — see
`docs/cross-machine-resume.md`.

</details>

<details>
<summary><strong>Secrets</strong></summary>

String values in `global/mcp.json` support two reference forms, resolved at render time:

- `${ENV_VAR}` — from the environment, falling back to a gitignored `secrets.env` (KEY=VALUE lines) at the repo root
- `op://vault/item/field` — via the [1Password CLI](https://developer.1password.com/docs/cli/)

Rendered agent configs get literal values (agents can't expand references); the repo never holds a raw secret — even private forks shouldn't. Unresolvable references fail the render loudly, naming the variable. `secrets.env` exists for machines without a secret-manager CLI: rendered configs already hold resolved values locally, so a local env file adds no new exposure class — copy it once per machine and keep the canonical copy in your secret manager.

</details>

<details>
<summary><strong>Multi-agent coordination</strong></summary>

`global/coordination.md` renders into every agent's instructions, so all of them follow one protocol: claim a GitHub issue (label `agent:claude` / `agent:codex` / `agent:cursor`) before non-trivial work, always work in a dedicated `git worktree`, branch under your namespace (`claude/*`, `codex/*`, `cursor/*`), integrate via PR only. The PR queue serializes conflicts; `git reflog` recovers from branch flips.

Claims are also enforced mechanically: `node hooks/lease-check.mjs claim <scope> --owner <agent>@<machine>` writes a lease file in git (`coordination/leases/`) and exits 2 if someone else holds a live lease. Stale leases expire by timestamp — no daemon. `bin/status.mjs` shows open leases fleet-wide.

</details>

<details>
<summary><strong>The learning loop (data flows back)</strong></summary>

Once sessions and smartloop runs accumulate, the same files feed improvement — still no
services, still no LLM calls inside the engine:

- `/rule-mine` — any agent scans memory + telemetry for corrections you had to make repeatedly
  and proposes the smallest `guardrails.md` edit as a PR. Agent-proposed, human-merged.
- `node bin/optimize.mjs --pacing` — regenerates `global/addenda/smartloop-pacing.md` with
  median wall-time/iteration priors from the trace corpus; smartloop consults it at sleep
  decisions.
- `node bin/optimize.mjs --regret` — lists runs that were marked done and later redone: the
  verification that passed them was too weak. `--apply-tiers` turns those into learned tier
  floors in `global/addenda/smartloop-tiers.md`, but only inside the floor/ceiling you declare
  in `global/smartloop-bounds.json` — no bounds file, no self-tuning. Every applied change is a
  git commit away from reverting.
- `node bin/optimize.mjs --export-dspy` — the corpus as a DSPy-ready dataset. Actually running
  a prompt optimizer against it is an explicit offline step you invoke with your own key —
  never part of any hook or render.
- `/memory-gc` understands decay: facts carry `(confirmed: YYYY-MM-DD)` dates; long-unconfirmed
  facts get flagged, then pruned on the next pass.

</details>

<details>
<summary><strong>Cost: zero, by design</strong></summary>

- **No LLM API calls anywhere.** Rendering is deterministic string assembly; memory is file injection. Your agents run entirely on the subscriptions you already pay for (Claude, ChatGPT/Codex, Cursor).
- **Token-frugal.** Hooks instead of MCP tools; a capped memory index instead of schema bloat; one set of instructions instead of three drifting copies.
- **No services.** Nothing to host, nothing metered, nothing that bills.

</details>

<details>
<summary><strong>Updating the engine</strong></summary>

Your repo is an instance of this template. To pull engine improvements:

```bash
git remote add upstream https://github.com/enckequity/samebrain.git   # once
git pull upstream main                                                # whenever
```

You edit `global/` and `memory/`; the template only evolves `bin/`, `hooks/`, and docs — so pulls merge cleanly. Setup already enabled auto-render after every pull (`git config core.hooksPath .githooks`), so config changes land the moment they arrive.

Tests live in `test/run.mjs` (no framework, no deps) and run on Linux/macOS/Windows in CI — `node test/run.mjs` locally before a PR.

</details>

<details>
<summary><strong>Honest limits</strong></summary>

Some surfaces are vendor-locked and cannot be file-synced; know them rather than fight them:

- **Cursor global User Rules** live only in the IDE's settings database (no file API). Keep `global/cursor-user-rules.md` as the canonical paste source — render nags when it changes until you re-paste and run `node bin/render.mjs --ack-cursor-rules`. Per-repo `.cursor/rules/*.mdc` carry the rest.
- **claude.ai OAuth connectors and Claude Code plugins** are account/installation state, not files.
- **Per-repo configs** (project AGENTS.md / CLAUDE.md / `.cursor/rules`) belong in each project's repo — samebrain handles the global layer only.

</details>

<details>
<summary><strong>Design notes</strong></summary>

- **Own renderer instead of an existing sync tool**: as of mid-2026 no tool rendered global rules + MCP + hooks across all three agents (the closest, rulesync, covers global rules for Claude Code/Copilot/opencode only). 150 lines was cheaper than the gap.
- **Markdown-in-git memory instead of mem0/OpenMemory**: OpenMemory is sunset; hosted memory adds a service dependency, latency, and token overhead for worse recall guarantees at personal scale.
- **Merge-only where agents own state**: `~/.claude.json` and hook files are merged key-by-key, never overwritten — samebrain coexists with whatever else manages those files.

</details>

## License

MIT
