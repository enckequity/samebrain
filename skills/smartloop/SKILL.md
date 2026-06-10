---
name: smartloop
description: Run any task as a token-optimized, verification-tiered, self-pacing loop with durable state. Use on /smartloop <task>, /smartloop resume [slug], /smartloop status, /smartloop backlog <source>.
---

# smartloop

Drive a task to verified completion at minimum token cost. Progress lives in a
state file OUTSIDE the conversation, so wakes, compaction, crashes, and rate
limits never lose work. The conversation is scratch; the state file is memory.

**State dir:** `$SMARTLOOP_DIR` or `~/.smartloop`. One run =
`<dir>/<slug>/state.md` + `<dir>/<slug>/evidence/`. Never inside a repo.

## Commands

- `/smartloop <task>` — start (slug = short kebab-case from the task)
- `/smartloop resume [slug]` — re-enter a run; with no slug and exactly one
  non-done run, resume that one; otherwise list and ask
- `/smartloop status` — print one line per run from the state files; nothing else
- `/smartloop backlog <source>` — queue-draining mode (below)

## State file format

```
---
slug: <task-slug>
status: working | waiting:<what> | limit-paused | done | blocked:<needs-user>
owner_session: <current session id>
next_wake: <ISO8601 when sleeping | parked | omit otherwise>
---
## Contract
Goal: <one line>
Criteria:
- [ ] <executable check — command/URL/condition>   [tier 0|1|2]
Out of scope: <explicit list>
Assumptions: <stated where the task was ambiguous>

## Journal
- <iter N> did X; learned Y; evidence: evidence/<file>

## Next action
<single concrete step any fresh session can execute>
```

Hard rules: the Contract is never edited after iteration 0 — criteria only get
checked off, each with an evidence pointer. Journal entries ≤3 lines, pointers
never payloads. A Stop hook audits `next_wake`: ending a turn with a
non-terminal run and no live wake (and not `parked`) is blocked.

## Every entry — start, wake, or resume — runs the same 6 steps

0. **Compile** (first entry only). Transform the raw task into the Contract:
   one-line goal; success criteria as executable checks, each tier-classified;
   out-of-scope list; stated assumptions. A code-producing task auto-adds the
   criterion "diff reviewed; CRITICAL/HIGH findings resolved" [tier 2]. Write
   the state file before any work.
1. **Rehydrate.** Read `state.md` — one file. Do not scroll conversation
   history to "remember"; if the answer is not in the state file, the journal
   was written wrong — fix the journal discipline instead.
2. **Triage** against the Contract: which criteria are unmet? Is the next
   action executable now, blocked on something external, or is everything
   verified (→ Finish)?
3. **Execute** the smallest unit that produces verifiable progress, through
   context firewalls: exploration, test-fix cycles, and audits run inside
   subagents whose contexts are disposable — only structured conclusions
   return. Use cheap/fast models for mechanical subagent work. Long commands
   run in the background; never await them by sleeping.
4. **Verify** per the criterion's tier (below). Evidence goes to `evidence/`;
   the journal records the pointer.
5. **Checkpoint.** Append a journal entry (≤3 lines); update Next action and
   status; roll journal entries older than the current phase into a 5-line
   summary once the journal exceeds ~80 lines; if about to sleep, write
   `next_wake`.
6. **Pace** with the wait ladder.

## Wait ladder (a wake replays the whole conversation as input — pay attention)

| Tier | When | Do |
|---|---|---|
| 0 | Waiting on harness-tracked work (background commands/agents/workflows) | No wake — the harness re-invokes on completion. At most one 3600s hang-guard. |
| 1 | Fast-changing external state (CI finishing in minutes) | Wakes ≤270s (prompt cache stays warm) |
| 2 | In-context state still genuinely valuable (hot debugging) | 1200–3600s; justify in the journal. Never 300–1100s. |
| 3 | Long/indefinite wait (limit pause, overnight, waiting on user) | **Park** (default): checkpoint, notify, `next_wake: parked`, end with no wake. Resume costs one state-file read. |

At every sleep decision: state what the wait is for, pick the lowest tier that
serves it, park when in doubt — the state file guarantees nothing is lost.

## Verification tiers

- **Tier 0 — mechanical** (file moves, config, docs): self-check — re-read or
  dry-run the result.
- **Tier 1 — code changes**: executed evidence required (test/build/probe run;
  excerpt saved to `evidence/`). Write the failing test first where the
  project's rules call for TDD.
- **Code review** — once per changeset at the integration boundary (changeset
  complete, before commit/PR), via a code-review subagent: the diff stays in
  its disposable context; only structured findings return. Findings become new
  iterations; re-review covers only the fix delta.
- **Tier 2 — ship-gates** (merge, deploy, external comms, money): one
  adversarial panel — 3 lenses (correctness, security, does-the-result-satisfy-
  the-contract), schema-forced verdicts, majority rules. For code, review and
  refutation merge into this single panel.
- When in doubt, tier up.

## Token rules (mandatory)

- Orchestrate, don't labor: heavy reads and noisy iteration belong in
  subagents. The loop session dispatches, verifies, checkpoints.
- Prefer symbol-level code reads (LSP/serena) when available; otherwise
  search first, then read only the needed range. Cap all output.
- Subagent prompts demand structured, capped returns.
- Evidence is pointed to, never pasted — not into the journal, not into chat.

## Limits and parking

On a rate-limit error: the state file is already current (step 5 ran last
iteration); set status `limit-paused`, notify, park. Resume from any session
via `/smartloop resume` — the SessionStart sweep surfaces it automatically.

## Finishing

Verify every criterion goal-backward against the Contract — against what was
promised, not what was done. Set status `done`, final journal entry, send a
one-line notification (done / blocked-on-user / limit-paused), no wake.

## Backlog mode

`/smartloop backlog <source>` — the Contract is "drain the queue": each item
becomes a sub-contract run through the full protocol. Honor the repo's
multi-agent claim protocol before starting an item; isolate per-item work in
its own worktree. Park at queue-empty or limit.
