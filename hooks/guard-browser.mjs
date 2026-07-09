#!/usr/bin/env node
// PreToolUse guard: browser automation belongs in a subagent, not the main thread.
//
// Screenshots are large and never leave context, so every later call in that session
// re-pays for every earlier screenshot. In measured sessions this dominated cache-read
// spend by a wide margin.
//
// FAILS OPEN BY DESIGN. Subagent payloads carry `agent_id`; main-thread payloads are
// believed not to. If that assumption is wrong, this hook simply never blocks — it
// never blocks a subagent, which is the path we want to protect.
//
// Escape hatch: CLAUDE_ALLOW_MAIN_BROWSER=1

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const LOG = join(homedir(), '.claude', 'hook-logs', 'guard-browser.jsonl');

const read = async () => {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
};

const main = async () => {
  let ev = {};
  try { ev = JSON.parse((await read()) || '{}'); } catch { process.exit(0); }

  // Observability: record whether agent_id is present, so we can confirm the
  // main-vs-subagent assumption from real traffic instead of guessing.
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify({
      tool: ev.tool_name, agent_id: ev.agent_id ?? null, agent_type: ev.agent_type ?? null,
    }) + '\n');
  } catch { /* logging must never break a tool call */ }

  if (process.env.CLAUDE_ALLOW_MAIN_BROWSER === '1') process.exit(0);
  if (ev.agent_id) process.exit(0);            // already in a subagent — allowed
  if (!String(ev.tool_name || '').startsWith('mcp__claude-in-chrome__')) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Browser automation must run inside a subagent, not the main thread. ' +
        'Screenshots are large and never leave context, so every later ' +
        'tool call in this session re-reads all of them. Spawn a subagent (Agent tool) ' +
        'to do the browser work and return only its conclusion. ' +
        'Prefer browser_batch over repeated computer calls. ' +
        'If main-thread browser work is genuinely required, re-run with CLAUDE_ALLOW_MAIN_BROWSER=1.',
    },
  }));
  process.exit(0);
};

main().catch(() => process.exit(0));   // never break the tool call
