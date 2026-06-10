---
name: memory-gc
description: Garbage-collect the shared agent memory index. Use on /memory-gc or when the recall hook warns that memory/MEMORY.md is over its line cap.
---

# memory-gc

Keep `{{REPO}}/memory/MEMORY.md` cheap: it is injected into every session of
every agent, so every line is a recurring token tax. Target: under 120 non-blank
lines, one line per fact.

## Procedure

1. Read `{{REPO}}/memory/MEMORY.md` and list the files in
   `{{REPO}}/memory/topics/`.
2. **Dedupe.** Merge lines stating the same fact; keep the most recent, most
   specific wording.
3. **Roll up.** Facts that are detail rather than index material move into the
   matching `memory/topics/<topic>.md` (create the topic file if needed),
   leaving at most a one-line pointer in the index.
4. **Prune.** Delete facts that are stale, superseded, or machine-specific to a
   machine that no longer exists. When unsure whether a fact is still true,
   keep it and flag it with `(verify)` rather than guessing.
5. **Show, don't commit.** Present the resulting diff of `MEMORY.md` (and any
   topic files) for approval. Never commit or push the change yourself — the
   session-end sync hook commits memory once the user accepts the edit.

Hard rules: never invent facts; never delete the index wholesale; preserve the
existing section structure; keep each fact to a single line.
