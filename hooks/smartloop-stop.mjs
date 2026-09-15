// Stop-hook dead-man check: a session may not end while it owns a smartloop run
// that is non-terminal (working/waiting) with no live next_wake and not parked.
// Exit 2 blocks the stop and feeds stderr back to the agent. Fail-silent otherwise.
// Agent-neutral: the session id arrives as session_id (Claude/Codex) or
// conversation_id (Cursor).
// Loop guard is a per-session cap on consecutive blocks, not stop_hook_active:
// that flag is also set when another Stop hook (auto-continue) blocked, which
// would otherwise switch this check off for the rest of the turn.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasLiveWake, isNonTerminal, readRuns, stateDir } from './smartloop-state.mjs';

const MAX_BLOCKS = 3;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(input); } catch { process.exit(0); }
  const sid = String(payload.session_id ?? payload.conversation_id ?? '').replace(/[^\w-]/g, '');
  if (!sid) process.exit(0);
  const blocks = join(stateDir(), '.stop-blocks', sid);
  const dead = readRuns().filter(
    (r) => r.owner_session === (payload.session_id ?? payload.conversation_id) && isNonTerminal(r) && !hasLiveWake(r),
  );
  if (dead.length === 0) {
    rmSync(blocks, { force: true });
    process.exit(0);
  }
  let n = 0;
  try { n = Number(readFileSync(blocks, 'utf8')) || 0; } catch { /* first block */ }
  if (n >= MAX_BLOCKS) process.exit(0);
  try {
    mkdirSync(join(stateDir(), '.stop-blocks'), { recursive: true });
    writeFileSync(blocks, String(n + 1));
  } catch { process.exit(0); } // cannot bound the loop without the counter: fail open
  console.error(
    `smartloop: non-terminal run(s) with no scheduled wake: ${dead.map((r) => r.slug).join(', ')}. `
    + 'Either schedule a wake and write next_wake (ISO) into the state file, set next_wake: parked '
    + 'for a deliberate park, or set status done/blocked with evidence.',
  );
  process.exit(2);
});
