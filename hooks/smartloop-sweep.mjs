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
