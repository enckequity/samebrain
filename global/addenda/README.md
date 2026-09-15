# Addenda

Optional per-agent appendix files, appended only to that agent's rendered instructions:

- `claude.md` → appended to `~/.claude/CLAUDE.md`
- `codex.md` → appended to `~/.codex/AGENTS.md`
- `kimi.md` → appended to `~/.kimi-code/AGENTS.md`
- `opencode.md` → appended to `~/.config/opencode/AGENTS.md`
- `openclaw.md` → appended inside the managed block in `~/.openclaw/workspace/AGENTS.md`

Use these for agent-specific pointers (e.g., Claude-only rules directories, Codex-only conventions, Kimi-specific tool conventions). `{{REPO}}` in any addendum is replaced with this repo's path at render time.
