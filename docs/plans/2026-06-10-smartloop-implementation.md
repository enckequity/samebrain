# smartloop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the smartloop engine component per `docs/plans/2026-06-10-smartloop-design.md` — the `/smartloop` skill, two liveness hooks, render wiring, and tests.

**Architecture:** A new `skills/` engine surface rendered to `~/.claude/skills/` by `bin/render.mjs`; two Node hook scripts (`hooks/smartloop-stop.mjs` Stop dead-man, `hooks/smartloop-sweep.mjs` SessionStart sweep) sharing a state-file parser (`hooks/smartloop-state.mjs`), registered merge-only into `~/.claude/settings.json`. State files live at `$SMARTLOOP_DIR` or `~/.smartloop/<slug>/state.md` with line-parseable frontmatter — no YAML lib, no deps, matching the engine's zero-dependency rule.

**Tech Stack:** Node ≥20 built-ins only. Tests extend `test/run.mjs` (framework-less, temp-dir HOME, runs on Linux/macOS/Windows CI).

**Worktree:** `~/sb-smartloop`, branch `claude/smartloop-impl`, refs issue #1.

**Conventions that bind every task:** ESM `.mjs`, 2-space indent, terse top-of-file comment stating purpose (match `hooks/recall.mjs` style), `join()` for all paths, never shell out, fail silent on missing dirs (hooks must never break a session).

---

### Task 1: State-file parser + Stop dead-man hook

**Files:**
- Create: `hooks/smartloop-state.mjs`
- Create: `hooks/smartloop-stop.mjs`
- Modify: `test/run.mjs` (append new block after block 10, before `rmSync`)

**Step 1: Write the failing tests**

Append to `test/run.mjs` immediately before the final `rmSync(work, ...)` line:

```js
// 11. smartloop-stop: dead-man fires only for owned, non-terminal, wake-less runs
{
  const sl = join(work, 'smartloop');
  const mkRun = (slug, fm) => {
    mkdirSync(join(sl, slug), { recursive: true });
    writeFileSync(join(sl, slug, 'state.md'),
      `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n## Contract\n`);
  };
  mkRun('dead-run', { slug: 'dead-run', status: 'working', owner_session: 's1' });
  mkRun('sleeping', { slug: 'sleeping', status: 'waiting:ci', owner_session: 's1', next_wake: '2099-01-01T00:00:00Z' });
  mkRun('parked', { slug: 'parked', status: 'waiting:user', owner_session: 's1', next_wake: 'parked' });
  mkRun('finished', { slug: 'finished', status: 'done', owner_session: 's1' });
  const stop = (payload) => spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-stop.mjs')], {
    env: { ...env, SMARTLOOP_DIR: sl }, input: JSON.stringify(payload), encoding: 'utf8',
  });
  const r1 = stop({ session_id: 's1' });
  t('dead run blocks stop (exit 2)', r1.status === 2);
  t('stderr names the run', r1.stderr.includes('dead-run'));
  t('stderr spares sleeping/parked/done', !r1.stderr.includes('sleeping') && !r1.stderr.includes('parked') && !r1.stderr.includes('finished'));
  t('other session unaffected', stop({ session_id: 's2' }).status === 0);
  t('stop_hook_active passes through', stop({ session_id: 's1', stop_hook_active: true }).status === 0);
  t('no state dir is silent', spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-stop.mjs')], {
    env: { ...env, SMARTLOOP_DIR: join(work, 'absent') }, input: '{"session_id":"s1"}', encoding: 'utf8',
  }).status === 0);
  t('garbage stdin is silent', stop !== null && spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-stop.mjs')], {
    env: { ...env, SMARTLOOP_DIR: sl }, input: 'not json', encoding: 'utf8',
  }).status === 0);
}
```

**Step 2: Run tests to verify they fail**

Run: `node test/run.mjs`
Expected: blocks 1–10 still `ok`; new block FAILs (`dead run blocks stop` etc.) because `smartloop-stop.mjs` doesn't exist (node exits 1, not 2).

**Step 3: Write the implementation**

`hooks/smartloop-state.mjs`:

```js
// Shared parser for smartloop state files (~/.smartloop/<slug>/state.md).
// Frontmatter is line-based key: value — no YAML lib, no deps.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const stateDir = () => process.env.SMARTLOOP_DIR ?? join(homedir(), '.smartloop');

export function readRuns(dir = stateDir()) {
  if (!existsSync(dir)) return [];
  const runs = [];
  for (const slug of readdirSync(dir)) {
    const p = join(dir, slug, 'state.md');
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    const fm = { slug };
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-z_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    runs.push(fm);
  }
  return runs;
}

export const isNonTerminal = (r) => r.status === 'working' || (r.status ?? '').startsWith('waiting');

export const hasLiveWake = (r) => {
  if (r.next_wake === 'parked') return true;
  const ts = Date.parse(r.next_wake ?? '');
  return Number.isFinite(ts) && ts > Date.now();
};
```

`hooks/smartloop-stop.mjs`:

```js
// Stop-hook dead-man check: a session may not end while it owns a smartloop run
// that is non-terminal (working/waiting) with no live next_wake and not parked.
// Exit 2 blocks the stop and feeds stderr back to Claude. Fail-silent otherwise.
import { hasLiveWake, isNonTerminal, readRuns } from './smartloop-state.mjs';

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(input); } catch { process.exit(0); }
  if (payload.stop_hook_active || !payload.session_id) process.exit(0);
  const dead = readRuns().filter(
    (r) => r.owner_session === payload.session_id && isNonTerminal(r) && !hasLiveWake(r),
  );
  if (dead.length === 0) process.exit(0);
  console.error(
    `smartloop: non-terminal run(s) with no scheduled wake: ${dead.map((r) => r.slug).join(', ')}. `
    + 'Either ScheduleWakeup and write next_wake (ISO) into the state file, set next_wake: parked '
    + 'for a deliberate park, or set status done/blocked with evidence.',
  );
  process.exit(2);
});
```

**Step 4: Run tests to verify they pass**

Run: `node test/run.mjs`
Expected: all pass including the 7 new assertions.

**Step 5: Commit**

```bash
git add hooks/smartloop-state.mjs hooks/smartloop-stop.mjs test/run.mjs
git commit -m "feat: smartloop state parser + Stop dead-man hook (refs #1)"
```

---

### Task 2: SessionStart sweep hook

**Files:**
- Create: `hooks/smartloop-sweep.mjs`
- Modify: `test/run.mjs` (append block 12 after block 11)

**Step 1: Write the failing tests**

```js
// 12. smartloop-sweep: surfaces non-done runs at session start, silent when none
{
  const sl = join(work, 'smartloop'); // fixtures from block 11
  const sweep = (dir) => spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-sweep.mjs')], {
    env: { ...env, SMARTLOOP_DIR: dir }, encoding: 'utf8',
  });
  const r = sweep(sl);
  t('sweep exits 0', r.status === 0);
  t('sweep lists non-done runs', r.stdout.includes('dead-run') && r.stdout.includes('parked'));
  t('sweep omits done runs', !r.stdout.includes('finished'));
  t('sweep gives resume hint', r.stdout.includes('/smartloop resume'));
  t('sweep silent when no runs', sweep(join(work, 'absent')).stdout.trim() === '');
}
```

**Step 2: Run to verify failure** — `node test/run.mjs`; block 12 FAILs (script missing).

**Step 3: Implementation**

`hooks/smartloop-sweep.mjs`:

```js
// SessionStart sweep: surface smartloop runs needing attention (orphaned, parked,
// limit-paused, blocked). Prints nothing when there is nothing — zero token tax.
import { readRuns } from './smartloop-state.mjs';

const runs = readRuns().filter((r) => r.status !== 'done');
if (runs.length > 0) {
  console.log('<smartloop-runs>');
  for (const r of runs) {
    const wake = r.next_wake ? ` (next_wake: ${r.next_wake})` : '';
    console.log(`- ${r.slug}: ${r.status}${wake} — /smartloop resume ${r.slug}`);
  }
  console.log('</smartloop-runs>');
}
```

**Step 4: Run to verify pass** — `node test/run.mjs`, all green.

**Step 5: Commit**

```bash
git add hooks/smartloop-sweep.mjs test/run.mjs
git commit -m "feat: smartloop SessionStart orphan sweep hook (refs #1)"
```

---

### Task 3: The skill + render wiring

**Files:**
- Create: `skills/smartloop/SKILL.md`
- Modify: `bin/render.mjs` (add `readdirSync` import; insert section 5 between section 4c and the report)
- Modify: `test/run.mjs` (append block 13)

**Step 1: Write the failing tests**

```js
// 13. smartloop: render publishes the skill and registers liveness hooks, idempotently
{
  const r = render();
  t('smartloop render exits 0', r.status === 0);
  const skill = at('.claude', 'skills', 'smartloop', 'SKILL.md');
  t('renders smartloop skill', existsSync(skill));
  t('skill keeps frontmatter first', read(skill).startsWith('---'));
  t('skill carries end marker', read(skill).includes('rendered by samebrain'));
  const settings = JSON.parse(read(at('.claude', 'settings.json')));
  const cmds = Object.values(settings.hooks).flat().flatMap((e) => e.hooks ?? []).map((h) => h.command);
  t('stop dead-man registered', cmds.some((c) => c.includes('smartloop-stop.mjs')));
  t('sweep registered', cmds.some((c) => c.includes('smartloop-sweep.mjs')));
  const r2 = render();
  t('smartloop render idempotent', r2.stdout.includes('everything in sync'));
}
```

**Step 2: Run to verify failure** — `node test/run.mjs`; block 13 FAILs (no skill rendered, hooks unregistered).

**Step 3a: Create `skills/smartloop/SKILL.md`** — complete content:

```markdown
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
```

**Step 3b: Wire `bin/render.mjs`**

Add `readdirSync` to the `node:fs` import list, then insert before the `// ---- report ----` section:

```js
// ---- 5. Skills + liveness hooks (Claude Code only) -----------------------------------
{
  const skillsDir = join(ROOT, 'skills');
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const src = join(skillsDir, name, 'SKILL.md');
      if (!existsSync(src)) continue;
      writeIfChanged(
        join(HOME, '.claude', 'skills', name, 'SKILL.md'),
        `${md(src)}\n\n${MARKER}\n`,
        `claude: ~/.claude/skills/${name}/SKILL.md`,
      );
    }
  }
}
mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json smartloop hooks', (s) => {
  s.hooks ??= {};
  const ensure = (event, command) => {
    s.hooks[event] ??= [];
    const all = s.hooks[event].flatMap((e) => e.hooks ?? []);
    if (!all.some((h) => h.command === command)) {
      s.hooks[event].push({ matcher: '', hooks: [{ type: 'command', command }] });
    }
  };
  ensure('SessionStart', cmd(join(ROOT, 'hooks', 'smartloop-sweep.mjs')));
  ensure('Stop', cmd(join(ROOT, 'hooks', 'smartloop-stop.mjs')));
});
```

Note: marker goes at the END of the rendered SKILL.md — frontmatter must stay
first for skill discovery. `md()` already applies the `{{REPO}}` token.

**Step 4: Run to verify pass** — `node test/run.mjs`, all green (blocks 1–13).

**Step 5: Commit**

```bash
git add skills/smartloop/SKILL.md bin/render.mjs test/run.mjs
git commit -m "feat: smartloop skill + render wiring for skills and liveness hooks (refs #1)"
```

---

### Task 4: Docs

**Files:**
- Modify: `README.md` (after the "Shared memory" section)

**Step 1: Add README section**

```markdown
## smartloop: a token-frugal loop for Claude Code

`/smartloop <task>` runs any task as a self-pacing loop with durable state
(`~/.smartloop/<slug>/state.md`): contract-first success criteria, tiered
verification, subagent context firewalls, cache-aware wake pacing, and
park/resume across rate limits. Two liveness hooks make silent loop death
impossible (Stop dead-man check) and surface orphaned runs at session start.
Claude Code only — design rationale in
`docs/plans/2026-06-10-smartloop-design.md`.
```

**Step 2: Sanity check** — `node bin/render.mjs --check` exits 0 in the worktree; `node test/run.mjs` still green.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: smartloop section in README (refs #1)"
```

---

### Task 5: Ship

**Step 1:** Full suite one more time: `node test/run.mjs` → `all tests passed`.

**Step 2:** Push and open PR:

```bash
git push -u origin claude/smartloop-impl
gh pr create --repo enckequity/samebrain --base main --title "feat: smartloop — token-optimized self-pacing loop skill" --body "Implements docs/plans/2026-06-10-smartloop-design.md. Fixes #1. Skill + state parser + Stop dead-man hook + SessionStart sweep + render wiring + 19 new assertions."
```

**Step 3:** Code review (per design: once per changeset, at the integration boundary) — dispatch the code-reviewer agent on the branch diff; address CRITICAL/HIGH before merge.

**Step 4:** After merge: in the private consumer repo (`~/agents-sync`), `git pull upstream main && node bin/render.mjs` to activate on this machine; same on the Mac Mini.
