---
name: rule-mine
description: Mine recent sessions for repeated user corrections and propose guardrail edits as a PR. Use on /rule-mine.
---

# rule-mine

Rules should evolve from evidence. This skill turns repeated corrections into a
proposed edit to `{{REPO}}/global/guardrails.md` — agent-proposed, human-merged.
Never edit guardrails directly; the PR is the safety gate.

## Procedure

1. **Gather signals.** Look for corrections the user had to make more than
   once: facts in `{{REPO}}/memory/MEMORY.md` and `memory/topics/*.md` recording
   "stop doing X" / "always do Y" moments, and your own recollection of this
   machine's recent sessions. Telemetry (`{{REPO}}/telemetry/`) shows which
   agents and machines were active where — use it to judge whether a pattern is
   one machine's quirk or fleet-wide.
2. **Cluster.** Group signals describing the same underlying behavior. A
   cluster qualifies only if it shows up **3+ times** or caused real damage
   once (reverted work, broken protected surface).
3. **Draft minimally.** For each qualifying cluster, draft the smallest
   guardrail edit that would have prevented it — one line where possible,
   matching the existing style of `guardrails.md`. No speculative rules.
4. **Propose as a PR.** Branch under your agent namespace, commit only the
   `global/guardrails.md` edit (message `feat: guardrail — <summary>`), open a
   PR whose body quotes the evidence: each correction, where it happened, and
   the memory/telemetry pointer. Follow the claim protocol in
   `global/coordination.md` first.
5. **Stop.** Never merge your own rule-mine PR; never edit rendered files.
   If no cluster qualifies, say so and propose nothing.
