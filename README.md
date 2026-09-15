# samebrain

[![ci](https://github.com/enckequity/samebrain/actions/workflows/ci.yml/badge.svg)](https://github.com/enckequity/samebrain/actions/workflows/ci.yml)

**One brain for every AI coding agent — Claude Code, Codex, Cursor, opencode and more — on every machine.**

Teach Claude Code something, and Codex never hears about it. Your laptop's agents don't know what your desktop's agents learned this morning. Every agent keeps its own rules, its own tool config, its own amnesia.

samebrain fixes that with one git repo:

- 📋 **One set of rules** — written once, rendered to every agent's native format
- 🧠 **One shared memory** — every agent reads it when a session starts, saves to it when it ends, and git syncs it between your machines
- 🔌 **One tool (MCP) config** — with secrets kept out of the repo

No servers. No API costs. Nothing to install beyond [Node.js](https://nodejs.org) and [git](https://git-scm.com), and no npm dependencies: plain Node scripts you can read. (Want semantic long-term memory on top? An optional Hindsight backend is built in (see *Optional: Hindsight long-term memory* below), and it stays off until you turn it on.)

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
| `skills/*/` | Skills, rendered to every agent (`targets:` frontmatter narrows the audience), plus optional `references/`, `scripts/`, `assets/` and `agents/` resources |
| `global/agents/<harness>/*.md` | Agent definitions rendered to that harness's agent dir (opencode → `~/.config/opencode/agent/`) |
| `plugins/*.{ts,js}` | opencode plugins (memory lifecycle, auto-continue, guardrails, notifications, cost telemetry) |
| `global/hindsight.json` | Optional Hindsight long-term memory wiring (`"enabled": false` by default) |
| `memory/MEMORY.md` | Shared memory — your agents maintain this themselves |

Always edit these files — never the rendered copies (those carry a "generated" marker and get overwritten).

## How it works

```
global/guardrails.md  ─┐
global/coordination.md ├─► node bin/render.mjs ──► ~/.codex/AGENTS.md
global/addenda/*.md   ─┤      (idempotent,         ~/.claude/CLAUDE.md
global/mcp.json       ─┘       deterministic)      ~/.cursor/mcp.json
                                                   ~/.claude.json  (mcpServers, merge-only)
                                                   session hooks in Claude Code, Codex, Cursor
                                                   AGENTS.md for Kimi Code, opencode, OpenClaw, …

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
| Skills | `~/.claude/skills/*` | `~/.codex/prompts/*` (`codex`) or native `~/.codex/skills/*` (`codex-skill`²) | `~/.cursor/skills/*` |
| Memory recall (session start) | `SessionStart` hook | `SessionStart` hook | `sessionStart` hook |
| Memory persist + telemetry (session end) | `SessionEnd` hook | `Stop` hook | `stop` hook |

¹ Codex loads every configured MCP server into memory; keeping `config.toml` lean is deliberate. Only servers that list `"codex"` in `targets` are rendered there.

² Pick one Codex target per skill: `codex` renders a slash-command prompt you invoke; `codex-skill` renders a native skill Codex triggers on its own. Rendering both would double-load it.

Skills default to `claude, cursor, codex`. Opt-in targets: `kimi` (Kimi Code), `codex-skill`, and `hermes` (`~/.hermes/skills/*`). A skill targeting both `kimi` and `codex-skill` renders once to the shared `~/.agents/skills/` directory both discover. Native skill targets get `SKILL.md` plus any `references/`, `scripts/`, `assets/` and `agents/` files copied byte-for-byte (file modes kept); flat Codex prompts point relative resource paths at the canonical skill directory in this repo.

Also covered, automatically detected (rendered only if the agent's directory exists):

- **Kimi Code** → `~/.kimi-code/AGENTS.md`
- **Gemini CLI** → `~/.gemini/GEMINI.md`
- **GitHub Copilot CLI** → `~/.copilot/instructions/samebrain.instructions.md`
- **opencode** → `~/.config/opencode/AGENTS.md` (it also reads `~/.claude/CLAUDE.md` by default, but an explicit file survives that default changing)
- **Factory Droid** → `~/.factory/AGENTS.md`
- **Pi** → `~/.pi/AGENTS.md`
- **OpenClaw** → a bounded managed block inside `~/.openclaw/workspace/AGENTS.md` (OpenClaw's own workspace guidance is preserved) and `~/.claude/skills` merge-added as its lowest-precedence extra skill root

Most of these agents don't expose session hooks, so their rendered instructions carry a memory-bootstrap line telling the agent to read the shared index at session start.

**opencode gets a full integration** through plugins, because its harness has no hook files. Render publishes every `plugins/*.{ts,js}` to `~/.config/opencode/plugins/`, declares the `@opencode-ai/plugin` dependency in `~/.config/opencode/package.json` (merge-only), points `skills.paths` in `opencode.json` at `~/.claude/skills` so every Claude-targeted skill reaches opencode, and renders `global/agents/opencode/*.md` to `~/.config/opencode/agent/`:

- `samebrain-memory.ts` — the memory lifecycle: pulls and re-renders once per session, injects a byte-bounded index into the system prompt of every model call (opencode rebuilds the system prompt per request, and its first request is often the title generator, so injecting once is not enough), keeps it through compaction, commits and pushes on idle/exit, and adds `memory_search` / `memory_read` / `memory_append` / `memory_sync` tools (plus `memory_retain` for the optional Hindsight backend). It spawns scripts with the node binary render found, not opencode's own executable. Knobs: `SAMEBRAIN_DISABLE=1`, `SAMEBRAIN_PULL=0`, `SAMEBRAIN_PERSIST=0`, `SAMEBRAIN_CAPTURE=0`, `SAMEBRAIN_MEMORY_MAX_BYTES` (default 14000), `SAMEBRAIN_DIR`.
- `auto-continue.js` — see *Autonomous sessions* below.
- `guardrails.js` — mechanizes the commit rules: blocks non-conventional or AI-attributed commit messages, hook-skipping / empty / interactive commits, force-push, git-config writes, and staging credential-looking files (`git add -A` included). `SAMEBRAIN_GUARDRAILS=0` disables it.
- `notify.js` — a throttled macOS notification when a session goes idle, errors, or waits on a permission prompt (`OPENCODE_NOTIFY=0`, `OPENCODE_NOTIFY_MIN_MS`).
- `telemetry.js` — cumulative per-session token and cost snapshots in `telemetry/<machine>/opencode-costs.jsonl` (`SAMEBRAIN_TELEMETRY=0`).

`node bin/render.mjs --check` reports drift without writing anything. The first render backs up anything it replaces to `backups/` (gitignored).

</details>

<details>
<summary><strong>Shared memory: why git instead of a memory server</strong></summary>

Every session of every agent starts with the contents of `memory/MEMORY.md` injected into context (after a fast, fail-silent `git pull`). The instructions rendered into every agent tell it to append durable facts — one line in the index, detail in `memory/topics/*.md`. At session end, a hook commits and pushes. Offline? Both hooks fail silently and reconcile on the next pull.

Why this beats an MCP memory server:

- **Unconditional recall.** The #1 failure mode of tool-based memory is the agent never calling the tool. A hook injects memory every time, no model judgment involved.
- **~1–3k tokens per session** for a disciplined index, vs 10–50k of tool schemas an MCP memory server adds to *every* request.
- **Zero infrastructure.** No embedding API, no vector store, no daemon eating RAM. Git is the sync protocol, the history, and the backup.
- **You own it.** Plain markdown, versioned, greppable, editable, portable.

Discipline: one line per fact, cap the index at ~120 lines and 12KB, prune stale facts. The index is a per-session token tax — keep it cheap, and bytes are what cost tokens. (The recall hook warns the agent automatically when the index goes over either cap, and the `/memory-gc` skill walks any agent through deduping, rolling detail into topics, and pruning — proposing a diff, never committing it.)

</details>

<details>
<summary><strong>Optional: Hindsight long-term memory</strong></summary>

The markdown index is the default and needs nothing else. If you also run a [Hindsight](https://github.com/vectorize-io/hindsight) server, samebrain can use it as a long-term memory backend: sessions are captured automatically, and each session start adds a bounded recall for the current repository next to the index.

It is **off by default** and fully opt-in:

1. Set `"enabled": true` in `global/hindsight.json`.
2. Put `HINDSIGHT_API_URL` and `HINDSIGHT_API_KEY` in the environment or the gitignored `secrets.env` (the variable names are configurable in the same file). Nothing Hindsight-related runs until both the flag and the keys are present.
3. Run `node bin/hindsight-activate.mjs` (`--check` reports what is missing). It stages the pinned `@vectorize-io/hindsight-coding-agents` runtime after verifying its registry integrity hash, retires the older `hindsight-memory` Claude Code plugin if installed, renders, and applies the bank setup.

Once enabled, render:

- writes `~/.hindsight/coding-agent.json` (owner-only; it holds the key) and adds a *Long-term memory* section to every rendered instruction file;
- after activation, wires the runtime's session-start, prompt and stop hooks plus its MCP server into Claude Code and Cursor, its capture hook into Codex, and its plugin into opencode;
- switches off Codex's native `memories` feature (one writer per kind of memory; set `codex.nativeMemories` to change that).

How memory flows back:

- **Session start.** `hooks/recall.mjs` still injects the markdown index first, then a `<hindsight_memories>` block: the knowledge pages and a recall for this repository's bank plus the global bank. It is cache-first: the last result is injected immediately with its age, and a detached refresher revalidates it for the next session; only a bank with no cache waits for a live read, bounded at 1.5s. One live read per bank runs at a time per machine. A slow or unreachable server never blocks the session and never removes the index.
- **Writing a fact directly.** `node bin/memory-retain.mjs --title "<title>" [--date YYYY-MM-DD] [--global] "<fact + evidence>"` stores a dated document (repository bank by default). Retaining the same title replaces it, so title a fix `Correction: <topic>`. Exit 3 = not enabled or unreachable. opencode's `memory_retain` tool calls it.
- **Session end.** `hooks/sync.mjs` queues a detached, ledgered backfill of the curated sources (`memory/` and Claude Code auto-memory), at most every 10 minutes (`SAMEBRAIN_HINDSIGHT_SYNC=0` turns it off). Unchanged files send nothing.
- **On demand.** `node bin/memory-search.mjs "<question>"` searches the repository bank plus the global bank (exit 1 = no match, 3 = not enabled or unreachable, so fall back to `memory/topics/`). opencode's `memory_search` tool uses it first and falls back to a local search over topics.
- **Banks.** A repository maps to its main worktree's directory name (linked worktrees share one bank); the home, Desktop, Documents and Downloads directories map to `globalBank`. `node bin/hindsight-banks.mjs` applies `bankSetup` (knowledge pages and directives) to the banks you list; `--check` reports drift and `--maintain` rebuilds drifting pages every `clearEveryHours`.
- **Autonomous opencode sessions** (agent-deck or `AUTO_CONTINUE=1`) are captured once per finished task, on a terminal marker, instead of on every model step.

Importing what you already have: `node bin/hindsight-backfill.mjs --dry-run` estimates the cost of sending the curated memory files (including Claude Code auto-memory from every project, routed to that project's bank) and recent Claude Code / Codex transcripts. Without `--dry-run` it sends them oldest to newest with curated files last, stops before `--max-usd` (default 40), skips unchanged documents, and aborts unless a canary proves the server redacts secrets (re-proven at most every `--canary-every-hours`, default 24). Extraction runs on your Hindsight server's model, so it costs whatever that server's provider charges.

Content is scrubbed client-side with the server's secret-redaction patterns (plus private-key blocks and `op://` references) before it leaves the machine. Kimi Code and the other bootstrap-line agents keep index-only memory, and interactive opencode sessions are not captured. `SAMEBRAIN_HINDSIGHT=0` switches the backend off on one machine (render, recall and scripts). Turning it off again does not unwire what activation added: remove the Hindsight hooks, the `hindsight` MCP entry, the opencode plugin entry and `~/.hindsight/coding-agent.json` by hand.

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
non-done run under one quota, cheapest rehydrate first. Before ship-bound work
finishes, smartloop runs an adversarial review loop over contract fit,
correctness, and safety/security/operations, then fixes and re-reviews blocking
findings. Design rationale in
`docs/plans/2026-06-10-smartloop-design.md`. The skill ships in
`skills/smartloop/` and renders like every other target.

Two lifecycle notes: runs with status `blocked:*` keep appearing at session
start until you mark them `done` or delete `~/.smartloop/<slug>/` — that is
"needs attention" semantics doing its job. And removing a skill from `skills/`
does not delete its published copy under `~/.claude/skills/` (the engine merges,
never deletes) — remove the published directory by hand if you retire one.

opencode has no native scheduled wake, so its runs are park-only and a scheduler
resumes them: `bin/smartloop-driver.sh` is one pass that resumes each non-done,
non-blocked run (honoring an optional `~/.smartloop/driver-allowlist`) with
`opencode run --auto --agent autonomous`. Install it as a launchd job with
`bin/smartloop-driver.sh --install` (opt-in, macOS; use cron or a systemd timer
on Linux), configured through env or a local `~/.smartloop/driver.env`. The
`autonomous` agent comes from `global/agents/opencode/autonomous.md`.

</details>

<details>
<summary><strong>Autonomous sessions: auto-continue</strong></summary>

Unattended sessions should not stop to ask "should I continue?". In an autonomous
session, samebrain injects a contract at session start and keeps the session going
until the agent's final message ends with a terminal marker on its own line:
`===AGENTDECK_DONE===` (verified complete), `BLOCKED: <reason>` (only a human can
unblock), or `WAITING: <what>` (background work will wake it). A stop without a
marker gets a nudge instead, at most `AUTO_CONTINUE_MAX` (default 25) per human
prompt, and question tools are denied so a dialog cannot stall the run.

It is active only inside [agent-deck](https://github.com/asheshgoplani/agent-deck)
sessions or with `AUTO_CONTINUE=1`; `AUTO_CONTINUE=0` always disables it, and
headless runs (`claude -p`, `opencode run`) never auto-continue. Claude Code gets
it as `SessionStart` / `UserPromptSubmit` / `Stop` / `PreToolUse` hooks
(`hooks/auto-continue.mjs`), opencode as `plugins/auto-continue.js`. The smartloop
Stop check counts its own consecutive blocks per session, so it keeps working when
auto-continue has already blocked a stop.

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
The same `--gc` prunes coordination leases that expired more than 7 days ago (override with
`SAMEBRAIN_LEASE_GRACE_DAYS`), plus malformed lease files; plain render only warns.

</details>

<details>
<summary><strong>Dashboards, evals, fleet status — local, zero services</strong></summary>

Everything reads the files already in your repo; nothing is hosted, nothing phones home:

- `node bin/dashboard.mjs` — writes a static `dashboard.html` (gitignored): sessions per month
  per machine/agent, run table (smartloop + agent-fleet, when a fleet records to `telemetry/<machine>/fleet-runs.jsonl`), memory index health. Open it in a browser.
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

To remove a server from every machine, delete its entry and list its name in `retiredMcpServers` in `global/mcp.json`: render deletes it from each `~/.claude.json`, which is merge-only, so a plain deletion would linger there (Cursor's file is fully owned, so dropping the entry is enough; Codex's opt-in `config.toml` sections are removed by hand).

Rendered agent configs get literal values (agents can't expand references); the repo never holds a raw secret — even private forks shouldn't. Unresolvable references fail the render loudly, naming the variable. `secrets.env` exists for machines without a secret-manager CLI: rendered configs already hold resolved values locally, so a local env file adds no new exposure class — copy it once per machine and keep the canonical copy in your secret manager.

</details>

<details>
<summary><strong>Multi-agent coordination</strong></summary>

`global/coordination.md` renders into every agent's instructions, so all of them follow one protocol: claim a GitHub issue (label `agent:claude` / `agent:codex` / `agent:cursor` / `agent:kimi`) before non-trivial work, always work in a dedicated `git worktree`, branch under your namespace (`claude/*`, `codex/*`, `cursor/*`, `kimi/*`), integrate via PR only. The `pr-workflow` skill walks an agent through that loop, and `security-review` covers changes that touch trust boundaries. The PR queue serializes conflicts; `git reflog` recovers from branch flips.

Claims are also enforced mechanically: `node hooks/lease-check.mjs claim <scope> --owner <agent>@<machine>` writes a lease file in git (`coordination/leases/`) and exits 2 if someone else holds a live lease. Stale leases expire by timestamp — no daemon; the session-end hook commits leases along with memory so a claim crosses machines, and `node bin/render.mjs --gc` prunes the dead ones. `bin/status.mjs` shows open leases fleet-wide.

Issue labels rot the same way: `node hooks/stale-claim-sweep.mjs [--repo owner/name]` flags open issues whose `agent:*` claim has no live PR and has gone quiet (a `stale-claim` label and one comment; it never removes the claim, and clears the flag once a PR or a new comment appears). It is a dry run unless you pass `--apply`.

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
- **No services.** Nothing to host, nothing metered, nothing that bills. The one exception is opt-in: the Hindsight client talks to a server you run, only after you enable it.

</details>

<details>
<summary><strong>Updating the engine</strong></summary>

Your repo is an instance of this template. To pull engine improvements:

```bash
git remote add upstream https://github.com/enckequity/samebrain.git   # once
git pull upstream main                                                # whenever
```

You edit `global/` and `memory/`; the template mostly evolves `bin/`, `hooks/`, `plugins/`, and docs — so pulls merge cleanly (if you enabled Hindsight, expect the occasional merge in `global/hindsight.json`). Setup already enabled auto-render after every pull (`git config core.hooksPath .githooks`), and the session-start recall hook re-renders whenever the engine revision changed since the last render (rebase pulls — like recall's own — never fire post-merge), so config changes land on every machine at the next session start, no manual step.

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

- **Own renderer instead of an existing sync tool**: as of mid-2026 no tool rendered global rules + MCP + hooks across Claude Code, Codex and Cursor (the closest, rulesync, covers global rules for Claude Code/Copilot/opencode only). A small dependency-free renderer was cheaper than the gap.
- **Markdown-in-git memory instead of mem0/OpenMemory**: OpenMemory is sunset; hosted memory adds a service dependency, latency, and token overhead for worse recall guarantees at personal scale. The optional Hindsight backend is layered on top rather than replacing it: the index is always injected, so memory degrades to markdown, never to nothing.
- **Merge-only where agents own state**: `~/.claude.json` and hook files are merged key-by-key, never overwritten — samebrain coexists with whatever else manages those files.

</details>

## License

MIT
