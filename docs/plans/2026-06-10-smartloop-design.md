# smartloop — token-optimized self-pacing loop skill

**Status:** Design approved 2026-06-10 · Issue: enckequity/samebrain#1
**Target:** samebrain public engine (MIT). Private config lives in consumer-repo overlays.

## Goal

A reusable loop template — `/smartloop <task>` — that drives any task to verified
completion with maximum accuracy per token spent, on a Claude subscription where
quota is shared with interactive work. Secondary mode: autonomous backlog worker
(`/smartloop backlog <source>`), which is the same protocol with a queue-draining
contract.

## Decisions (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Substrate | Markdown skill on native dynamic-/loop primitives (`ScheduleWakeup`, `Agent`, `Workflow`, `PushNotification`) | Harness already provides pacing, background-task notification, structured subagent returns. A skill encodes discipline; no infrastructure to maintain. |
| Hooks | Two thin **liveness guardrails** — never the iteration engine | Stop-hook re-injection (Ralph-style) forces iteration in one ever-growing context: token bonfire. Guardrail hooks cost ~nothing and close the skill's real failure modes (silent loop death, orphaned runs). |
| Accuracy bar | Tiered by risk | Verification spends tokens; spend them where wrongness is expensive. |
| Quota policy | Limit-aware + auto-resume via **park** | Heartbeat wakes during a limit window replay full context for zero progress. Parking resumes at ~5k tokens from any session. |
| Prompt optimization | Contract compilation (iteration 0), **no DSPy in the hot path** | DSPy compiles prompts against a metric over many rollouts — wrong economics for one-off tasks with no per-task eval signal. Contract compilation captures ~80% of the value at ~1% of the cost. DSPy fits the **v2 seam**: offline optimization of the protocol text against accumulated run traces. |
| Plugin packaging | None | Plugins add only hooks (rejected as engine) and distribution (samebrain already does it). |
| Protocol adherence | Every wake re-enters via `/smartloop resume <slug>` → Skill tool re-fires → full protocol text reloads fresh each wake | Adherence does not decay with context age; the state file re-anchors the task. |

## Architecture

Three pieces, no code beyond two small hook scripts:

1. **`skills/smartloop/SKILL.md`** — the protocol: iteration algorithm, pacing
   ladder, verification tiers, quota handling, token rules.
2. **State file** — the loop's brain: `~/.smartloop/<task-slug>/state.md`
   (+ `evidence/` dir). Written before the first action, checkpointed after
   every iteration. The conversation is scratch space; the state file is memory.
   Never lives inside a repo (journals contain real paths/output).
3. **Two liveness hooks** (rendered via `render.mjs` like all engine hooks):
   - **Stop dead-man check** — protocol writes `next_wake: <iso>` when
     scheduling. On Stop: if this session owns a run with status
     `working|waiting` and no live `next_wake` → exit 2: "run X is non-terminal:
     schedule a wakeup or mark it done/blocked with evidence." Silent loop death
     becomes impossible.
   - **SessionStart orphan sweep** — list runs with non-terminal status and
     stale `next_wake` (process died, machine rebooted): "orphaned loop:
     `/smartloop resume <slug>`".

### Invocation surface

- `/smartloop <task>` — start
- `/smartloop resume [slug]` — pick up any paused/orphaned run (also the
  wake re-entry prompt)
- `/smartloop status` — one line per run from `~/.smartloop/*/state.md`
- `/smartloop backlog <source>` — queue-draining mode
- Terminal states fire `PushNotification` (done / blocked-on-user / limit-paused).

### State file format

```markdown
---
slug: <task-slug>
status: working | waiting:<what> | limit-paused | done | blocked:<needs-user>
owner_session: <session-id>
next_wake: <iso8601 | none>
---
## Contract            (written by iteration 0; never edited, only marked verified)
Goal: <one line>
Criteria:
- [ ] <executable check — command/URL/condition>   [tier 0|1|2]
Out of scope: <explicit list>
Assumptions: <stated where the prompt was ambiguous>

## Journal             (≤3 lines per entry; pointers, never payloads)
- <iter N> did X; learned Y; evidence: evidence/<file>

## Next action
<single concrete step any fresh session can execute>
```

## Iteration algorithm (every entry: first run, wake, or resume)

0. **Compile** (first entry only). Raw task → Contract: one-line goal,
   executable success criteria with a verification tier each, out-of-scope
   list, stated assumptions. Code-producing tasks auto-add the criterion
   *"diff reviewed; CRITICAL/HIGH findings resolved."* Write state file
   before any work.
1. **Rehydrate.** Read `state.md` — one file. Scrolling conversation history
   to "remember" is a protocol violation; if the answer isn't in the state
   file, the journal was written wrong.
2. **Triage.** Against the Contract: unmet criteria? Next action executable
   now, blocked external, or all verified (→ finalize)?
3. **Execute.** Smallest unit producing verifiable progress, through
   **context firewalls**: exploration, test-fix cycles, audits run in
   subagents whose contexts are disposable (Haiku for mechanical, inherit
   for judgment). The orchestrator only dispatches, reads structured
   returns, verifies. Long commands: `run_in_background`, never awaited by
   sleeping.
4. **Verify.** Per the criterion's tier (below). Evidence → `evidence/`;
   journal gets the pointer.
5. **Checkpoint.** Journal entry ≤3 lines; update next-action + status;
   self-compact journal past ~80 lines (roll old entries into a 5-line
   phase summary); if sleeping, write `next_wake`.
6. **Pace.** The wait ladder (below).

## Pacing: wake economics and the wait ladder

A wake replays the **entire conversation as input tokens**. ≤270s after last
activity: warm cache (~10% cost). >300s: full price. Wake cost is proportional
to context size at sleep time — firewalls compound into cheaper wakes. Past a
crossover, ending the session and resuming fresh from the state file (~3–5k
tokens) beats even one cold full-context wake.

| Tier | When | Mechanism |
|---|---|---|
| 0 | Harness-tracked work (background commands/agents/workflows) | **No wake** — harness re-invokes on completion. At most one 3600s hang-guard. |
| 1 | Fast-changing external state (CI finishing in minutes) | ≤270s warm bursts |
| 2 | In-context state still genuinely valuable (hot debugging) | 1200–3600s; justification required in journal. **Never 300–1100s** (dead zone: cache miss without amortization). |
| 3 | Long/indefinite waits (limit pause, overnight, waiting on user) | **Park**: checkpoint, `PushNotification`, end with no wake. Resume = one state-file read in a fresh tiny context (next session via orphan sweep, `/smartloop resume`, or optional one-shot `/schedule`). |

Rule: at every sleep decision, state what the wait is for, pick the lowest
tier that serves it, park by default — the state file guarantees nothing is
lost.

## Token-efficiency stack (layered)

1. **Firewall** — junk never enters the orchestrator context (subagents do
   dirty work; disposable contexts).
2. **Park** — controlled reset to ~5k via durable state. (Harness
   auto-compact may still fire; the design is immune — rehydrate re-reads
   state every iteration. `/compact` is not self-invocable and is the lossy
   last resort this design avoids needing.)
3. **Pacing ladder** — wakes only for genuinely external, untracked state.
4. **Read discipline** — serena symbol-level reads *if the MCP is present*,
   else Grep → targeted Read with offset/limit; `head_limit` everywhere;
   RTK ambient via hooks if installed. Capability-detected, never assumed.
5. **Return discipline** — schema-forced subagent returns; evidence as
   pointers, never payloads in journal or chat.
6. **Self-compacting state** — journal rolls up past ~80 lines; rehydrate
   cost stays flat on week-long runs.
7. **Model tiering** — Haiku for mechanical subagent steps; the orchestrator
   and judgment phases stay on the session model.

## Verification tiers

- **Tier 0 — mechanical** (file moves, config edits, docs): self-check —
  re-read or dry-run. No subagents.
- **Tier 1 — code changes**: executed evidence required (test/build/probe
  run, excerpt saved to `evidence/`). TDD per consumer rules — the failing
  test is evidence the criterion is real.
- **Code review — once per changeset, not per iteration.** Fires at the
  integration boundary (changeset complete, before commit/PR) via a Code
  Reviewer subagent: diff dump stays in its disposable context; structured
  findings return (severity / file:line / issue). Findings → new iterations;
  re-review covers only the fix delta. Security-sensitive surfaces add the
  security-review trigger. Public core ships a generic review prompt;
  consumer overlays may point at richer agents.
- **Tier 2 — ship-gates** (merge, deploy, external comms, money): adversarial
  panel — one Workflow call, 3 lenses (correctness, security,
  does-the-diff-satisfy-the-contract), schema-forced verdicts, majority
  rules. For code tasks, review and refutation merge into this single panel.
- Classification rule: when in doubt, tier up.

## Limit handling

Rate-limit error → state is already checkpointed (step 5 guarantees it) →
status `limit-paused`, `PushNotification`, **park**. Rejected-while-limited
calls don't consume quota; resuming fresh costs ~5k instead of replaying the
full conversation. Any session can resume.

## Backlog mode

`/smartloop backlog <source>` — contract = "drain the queue"; each item runs
the full protocol as a sub-contract. Multi-agent claim protocol (issue claim +
agent label) and queue sources come from **consumer overlay config**, not the
engine. Worktree per item. Parks at queue-empty or limit.

## Open-source split

- **Public core (samebrain):** SKILL.md, both hooks, state-file spec, generic
  review prompt. Fully generic — no consumer-specific accounts, paths, or
  tools. Hard dependencies are Claude Code built-ins only.
- **Private overlay (consumer repos, e.g. agents-sync):** backlog sources,
  repo lists, claim-label conventions, richer reviewer agents.
- State dir `~/.smartloop/` (overridable), outside any checkout.

## v2 seam (deliberately not built now)

Every run's state file + journal is a structured trace
(task → iterations → outcome → tokens). Once dozens accumulate, that corpus
is a DSPy training set for offline optimization of the contract-compilation
instructions and backlog prompt — optimize once, reuse forever. v1 only
guarantees the trace format.

## Out of scope (v1)

- DSPy or any prompt-optimization service in the hot path
- Plugin packaging / marketplace distribution
- Hook-driven iteration (Ralph-style re-injection)
- Cross-machine loop migration (state files are per-machine; resume is manual
  via `/smartloop resume` after syncing if ever needed)
