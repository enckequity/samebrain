# Multi-Agent Work Coordination

Multiple AI agents (Claude Code, Codex, Cursor) work these repos concurrently from multiple machines. Protocol:

1. **Claim before working.** Before starting non-trivial work: `gh issue list --state open` — if an open issue covers the task and is assigned or labeled `agent:*`, it's claimed: STOP. To claim: create/self-assign the issue and add your label (`agent:claude` / `agent:codex` / `agent:cursor`). One issue = one task = one agent. Stale claims (>24h, no linked branch) are fair game.
2. **Isolate physically.** Always work in a dedicated `git worktree` — never two agents in one checkout. Never work on another agent's branch.
3. **Branch namespaces.** Prefix branches: `claude/*`, `codex/*`, `cursor/*`.
4. **Integrate via PR only.** Every change ships as a PR referencing its issue (`Fixes #N`). The PR queue serializes conflicts.
5. **Lost commits** after a branch flip: recover via `git reflog`.
