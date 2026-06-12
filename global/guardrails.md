# Global Engineering Guardrails

Behavioral guidelines to reduce common LLM coding mistakes. Project-level AGENTS.md / CLAUDE.md override these where they conflict. Tradeoff: bias toward caution over speed; for trivial tasks, use judgment.

## 1. Think Before Coding

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what's confusing, ask.

## 2. Simplicity First

- Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked. No abstractions for single-use code.
- No unrequested "flexibility" or "configurability". No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite it. Test: "Would a senior engineer call this overcomplicated?"

## 3. Surgical Changes

- Touch only what you must. Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken. Match existing style.
- Remove imports/variables/functions YOUR changes made unused; leave pre-existing dead code (mention it instead).
- Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

- Define success criteria, loop until verified.
- "Fix the bug" → write a test that reproduces it, then make it pass.
- For multi-step tasks, state a brief plan with a verification per step.

## 5. Adversarial Review Loop

- Before calling non-trivial work done, attack the result from three lenses:
  contract fit, correctness, and safety/operations.
- Record findings as severity / evidence / required fix. Fix every critical or
  high finding, and any medium finding that affects the contract.
- Re-run the review on the fix delta until no blocking findings remain. If a
  risk is intentionally accepted, name the owner/user decision in the final note.
- For trivial docs/copy-only changes, a quick self-review is enough; do not add
  ceremony.

## 6. Context / Token Economy

- Cap output: never dump unbounded results. Search/locate first, then open only the specific section needed (± a few lines).
- Pipe noisy shell output through `head -n N` / `Select-Object -First N`. For unknown-size output, write to a temp file and inspect ranges.
- Skip `node_modules`, `.venv`, `dist`, `build`, `.next`, caches, lockfiles, generated/minified files unless the task is about them.
- Terse by default: lead with the answer/patch + a one-line why. No preamble or recap padding.
- Fan out to subagents/parallel sessions for breadth when the platform supports it.

## Conventions

- Research before implementing: GitHub code search first (`gh search repos/code`), library docs second, broader web search last. Check package registries before writing utility code; prefer service-maintained packages over hand-rolled code.
- Immutability over mutation. KISS / DRY / YAGNI.
- Many small files > few large files (200-400 lines typical, 800 max). Functions <50 lines, nesting <4 levels.
- Validate at system boundaries; handle errors explicitly; never silently swallow errors.
- No hardcoded secrets — env vars or a secret manager (e.g., 1Password `op`) only.
- Conventional commits: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci). No AI attribution lines.
- Testing: TDD (red → green → refactor), 80%+ coverage target, AAA pattern, descriptive test names.

## Shared Memory

Durable cross-agent facts live in `{{REPO}}/memory/MEMORY.md` (index) + `{{REPO}}/memory/topics/*.md` (detail). The index is injected at session start by hooks. When you learn a durable fact (infra quirk, account mapping, decision, gotcha), append it: one line in MEMORY.md, detail in a topic file if needed, then it syncs via git automatically at session end. Keep index entries to one line; cap the index at ~120 lines.
