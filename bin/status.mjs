#!/usr/bin/env node
// One-screen fleet view, from files and git history alone.
//   node bin/status.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const jsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
  try { return [JSON.parse(l)]; } catch { return []; }
});

console.log('samebrain status\n');

// Machines: telemetry dirs, current-month session counts, last record, last git-synced commit.
const telemetryRoot = join(ROOT, 'telemetry');
const month = new Date().toISOString().slice(0, 7);
const machines = existsSync(telemetryRoot)
  ? readdirSync(telemetryRoot).filter((m) => { try { return readdirSync(join(telemetryRoot, m)).length > 0; } catch { return false; } })
  : [];
if (machines.length === 0) {
  console.log('  machines: none seen yet (telemetry appears after agent sessions end)');
}
for (const machine of machines) {
  const monthFile = join(telemetryRoot, machine, `${month}.jsonl`);
  const recs = existsSync(monthFile) ? jsonl(monthFile) : [];
  let synced = '';
  try {
    const ts = execFileSync('git', ['log', '-1', '--format=%cs', '--', `telemetry/${machine}`], {
      cwd: ROOT, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (ts) synced = `, last git sync ${ts}`;
  } catch { /* not a clone or no history — fine */ }
  const last = recs.at(-1)?.ts ? `, last record ${recs.at(-1).ts}` : '';
  console.log(`  machine ${machine}: ${recs.length} session(s) this month${last}${synced}`);
}

// smartloop runs across all machines.
const runs = machines.flatMap((m) => {
  const p = join(telemetryRoot, m, 'smartloop-runs.jsonl');
  return existsSync(p) ? jsonl(p) : [];
});
if (runs.length) {
  const by = {};
  for (const r of runs) by[r.outcome ?? 'unknown'] = (by[r.outcome ?? 'unknown'] ?? 0) + 1;
  console.log(`  smartloop: ${runs.length} run(s) recorded (${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ')})`);
}

// Coordination leases (written from v4 on): list live claims, flag expired ones.
const leasesDir = join(ROOT, 'coordination', 'leases');
if (existsSync(leasesDir)) {
  const now = new Date().toISOString();
  for (const f of readdirSync(leasesDir).filter((f) => f.endsWith('.lease'))) {
    try {
      const lease = JSON.parse(readFileSync(join(leasesDir, f), 'utf8'));
      const state = lease.expires > now ? 'held' : 'EXPIRED';
      console.log(`  lease ${f.replace(/\.lease$/, '')}: ${state} by ${lease.owner} until ${lease.expires}`);
    } catch { /* malformed lease — ignore */ }
  }
}
