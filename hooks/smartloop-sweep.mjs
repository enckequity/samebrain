// SessionStart sweep: surface smartloop runs needing attention (orphaned, parked,
// limit-paused, blocked). Prints nothing when there is nothing — zero token tax.
//   --cursor      wrap output in Cursor's sessionStart JSON contract
//   --portfolio   ordered drain queue across all non-done runs (cheap first,
//                 limit-paused deferred) — used by /smartloop portfolio
import { hasLiveWake, readRuns } from './smartloop-state.mjs';

const lines = [];

if (process.argv.includes('--portfolio')) {
  const runs = readRuns().filter((r) => r.status !== 'done');
  if (runs.length > 0) {
    const active = runs.filter((r) => r.status !== 'limit-paused')
      .sort((a, b) => a.journal_lines - b.journal_lines); // cheapest rehydrate first
    const deferred = runs.filter((r) => r.status === 'limit-paused');
    lines.push('<smartloop-portfolio>');
    active.forEach((r, i) => lines.push(`${i + 1}. ${r.slug}: ${r.status} (journal ${r.journal_lines} lines) — /smartloop resume ${r.slug}`));
    for (const r of deferred) lines.push(`deferred: ${r.slug} (limit-paused — retry after the limit window)`);
    lines.push('</smartloop-portfolio>');
  }
} else {
  const runs = readRuns().filter(
    (r) => r.status !== 'done' && (!hasLiveWake(r) || r.next_wake === 'parked'),
  );
  if (runs.length > 0) {
    lines.push('<smartloop-runs>');
    for (const r of runs) {
      const wake = r.next_wake ? ` (next_wake: ${r.next_wake})` : '';
      lines.push(`- ${r.slug}: ${r.status}${wake} — /smartloop resume ${r.slug}`);
    }
    lines.push('</smartloop-runs>');
  }
}

if (lines.length === 0) process.exit(0);
if (process.argv.includes('--cursor')) {
  process.stdout.write(JSON.stringify({ additional_context: lines.join('\n') }));
} else {
  console.log(lines.join('\n'));
}
