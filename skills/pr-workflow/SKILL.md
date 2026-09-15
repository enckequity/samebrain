---
name: pr-workflow
description: Ship repository changes through the claim → worktree → branch → PR → merge loop. Use when the user asks to fix, build, or open a PR for a shared repo, or before starting any non-trivial change to someone else's checkout.
---

# PR workflow

Every non-trivial change to a shared repo ships as a PR tied to a claim. This is
the serialization point that keeps concurrent agents from clobbering each other.
The canonical protocol is `{{REPO}}/global/coordination.md`; read it before
starting.

## 1. Claim the work

- `gh issue list --state open` first. If an open issue covers the task and is
  assigned or labeled `agent:*`, STOP — someone owns it. A claim older than 24h
  with no linked branch is fair game.
- Otherwise create or self-assign an issue and add your label
  (`agent:claude`, `agent:codex`, `agent:cursor`, `agent:kimi`). One issue = one
  task = one agent.
- Where the samebrain repo is present, back the claim mechanically:
  `node {{REPO}}/hooks/lease-check.mjs claim <scope> --owner <agent>@<machine>`
  (exit 2 = already held). Release it when done and commit the lease file.

## 2. Isolate physically

- Work in a dedicated `git worktree`, never a shared checkout:
  `git worktree add ../<repo>-<slug> -b <agent>/<slug>`.
- Branch prefix by agent: `claude/*`, `codex/*`, `cursor/*`, `kimi/*`. Never
  work on another agent's branch.

## 3. Change and verify

- Make the smallest change that satisfies the issue. Match existing style; touch
  nothing unrelated.
- Run the repo's own verification commands. Capture the output — it belongs in
  the PR.
- Conventional commits only (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
  `chore:`, `perf:`, `ci:`). No AI attribution lines.

## 4. Open the PR

- Push the branch and open a PR whose body names the issue with `Fixes #N`, the
  approach in one or two lines, and the exact verification evidence.

## 5. Merge

- The PR queue serializes conflicts; do not merge your own work until the checks
  or the reviewer clear it.
- Release your claim (issue label and lease) after the merge lands.

If a branch flip loses commits, recover them with `git reflog` before restarting.
