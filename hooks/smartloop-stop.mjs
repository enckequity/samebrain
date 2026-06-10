// Stop-hook dead-man check: a session may not end while it owns a smartloop run
// that is non-terminal (working/waiting) with no live next_wake and not parked.
// Exit 2 blocks the stop and feeds stderr back to Claude. Fail-silent otherwise.
import { hasLiveWake, isNonTerminal, readRuns } from './smartloop-state.mjs';

let input = '';
process.stdin.setEncoding('utf8');
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
