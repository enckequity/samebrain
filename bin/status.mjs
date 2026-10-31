#!/usr/bin/env node
// One-screen fleet view, from files and git history alone.
//   node bin/status.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const jsonl = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
  try { return [JSON.parse(l)]; } catch { return []; }
});

console.log('samebrain status\n');

// Use local refs only: status must work offline and leave shared work untouched.
const git = (args) => execFileSync('git', args, {
  cwd: ROOT, timeout: 5000, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
try {
  const branch = git(['branch', '--show-current']) || 'detached HEAD';
  const dirty = git(['status', '--porcelain', '--no-renames', '-z']).split('\0').filter(Boolean).length;
  let upstream = 'upstream unavailable';
  try {
    const [ahead, behind] = git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).split(/\s+/);
    upstream = `${ahead} ahead, ${behind} behind (last fetched)`;
  } catch { /* No upstream, or its history cannot be read. */ }
  console.log(`  git: ${branch}, ${upstream}, ${dirty} uncommitted path(s)`);
} catch {
  console.log('  git: unavailable; inspect repository access and Git object health');
}

// Show timestamps only. Cached memory can contain private project details.
const recallDir = join(homedir(), '.hindsight', 'samebrain-recall-cache');
let caches = null;
try {
  caches = existsSync(recallDir) ? readdirSync(recallDir).filter((f) => f.endsWith('.json')) : [];
} catch {
  console.log('  recall: cache directory unavailable; inspect local file access');
}
if (caches?.length === 0) console.log('  recall: no local cache (Hindsight may be disabled or not yet used)');
for (const file of caches ?? []) {
  const bank = file.slice(0, -5).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '?').slice(0, 100);
  try {
    const { at } = JSON.parse(readFileSync(join(recallDir, file), 'utf8'));
    const age = Date.now() - Date.parse(at);
    if (typeof at !== 'string' || !Number.isFinite(age) || age < 0) throw new Error('invalid timestamp');
    const label = age >= 86400000 ? `${Math.floor(age / 86400000)}d ago` : `${Math.floor(age / 60000)}m ago`;
    console.log(`  recall ${bank}: ${age >= 86400000 ? 'STALE' : 'fresh'}, last refreshed ${label}`);
  } catch {
    console.log(`  recall ${bank}: invalid cache; run memory-search to check live recall`);
  }
}

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

// smartloop + agent-fleet runs across all machines.
for (const [label, file] of [['smartloop', 'smartloop-runs.jsonl'], ['fleet', 'fleet-runs.jsonl']]) {
  const runs = machines.flatMap((m) => {
    const p = join(telemetryRoot, m, file);
    return existsSync(p) ? jsonl(p) : [];
  });
  if (!runs.length) continue;
  const by = {};
  for (const r of runs) by[r.outcome ?? 'unknown'] = (by[r.outcome ?? 'unknown'] ?? 0) + 1;
  console.log(`  ${label}: ${runs.length} run(s) recorded (${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ')})`);
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
