#!/usr/bin/env node
// Build dashboard.html from telemetry/ + memory/ — a static, dependency-free local page.
//   node bin/dashboard.mjs            writes dashboard.html at the repo root (gitignored)
// No server, no build step, no network: data is inlined; open the file in a browser.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(p, 'utf8');
const jsonl = (p) => read(p).split('\n').filter(Boolean).flatMap((l) => {
  try { return [JSON.parse(l)]; } catch { return []; }
});

// ---- collect ---------------------------------------------------------------------------
const months = {}; // "YYYY-MM" -> { "machine/agent": count }
const runs = [];
const telemetryRoot = join(ROOT, 'telemetry');
if (existsSync(telemetryRoot)) {
  for (const machine of readdirSync(telemetryRoot)) {
    const dir = join(telemetryRoot, machine);
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (/^\d{4}-\d{2}\.jsonl$/.test(f)) {
        for (const rec of jsonl(join(dir, f))) {
          const key = `${machine}/${rec.agent ?? 'unknown'}`;
          (months[f.slice(0, 7)] ??= {})[key] = ((months[f.slice(0, 7)] ?? {})[key] ?? 0) + 1;
        }
      } else if (f === 'archive.jsonl') {
        for (const sum of jsonl(join(dir, f))) {
          for (const [agent, n] of Object.entries(sum.by_agent ?? {})) {
            (months[sum.month] ??= {})[`${machine}/${agent}`] = ((months[sum.month] ?? {})[`${machine}/${agent}`] ?? 0) + n;
          }
        }
      } else if (f === 'smartloop-runs.jsonl') {
        // tags last: a stray machine/source field in a record must not clobber them
        for (const run of jsonl(join(dir, f))) runs.push({ ...run, machine, source: 'smartloop' });
      } else if (f === 'fleet-runs.jsonl') {
        for (const run of jsonl(join(dir, f))) runs.push({ ...run, machine, source: 'fleet' });
      }
    }
  }
}

let memory = { lines: 0, cap: 120, verify_flags: 0 };
try {
  const index = read(join(ROOT, 'memory', 'MEMORY.md'));
  memory.lines = index.split('\n').filter((l) => l.trim()).length;
  memory.verify_flags = (index.match(/\(verify\)/g) ?? []).length;
} catch { /* no index yet */ }

// Rule effectiveness: which guardrail revision was live, against correction proxies —
// memory (verify) flags and smartloop regret (done-then-redone runs).
const rules = { hash: null, changed: null, revisions: 0, regrets: 0 };
try {
  rules.hash = createHash('sha256').update(read(join(ROOT, 'global', 'guardrails.md'))).digest('hex').slice(0, 12);
  const log = execFileSync('git', ['log', '--format=%cs', '--', 'global/guardrails.md'], {
    cwd: ROOT, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim().split('\n').filter(Boolean);
  rules.changed = log[0] ?? null;
  rules.revisions = log.length;
} catch { /* no git history — hash alone still renders */ }
{
  // Regret is a smartloop concept (done-then-redone = weak verification); fleet tasks
  // legitimately re-run under the same id (Autopilot passes), so they don't count.
  const seenDone = new Set();
  for (const r of runs.filter((r) => r.source !== 'fleet').sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''))) {
    if (seenDone.has(r.slug)) rules.regrets += 1;
    if (r.outcome === 'done') seenDone.add(r.slug);
  }
}

// Newest-first, capped: fleet appends one line per terminal task, so the corpus outgrows
// what a single inlined HTML table should carry long before the files need rotating.
runs.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
const data = { generated: new Date().toISOString(), months, runs: runs.slice(0, 500), memory, rules };

// ---- render ----------------------------------------------------------------------------
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>samebrain dashboard</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: .3rem .6rem; border-bottom: 1px solid #e5e5e5; }
  .bar { display: inline-block; height: .7rem; background: #4a7dba; vertical-align: middle; margin-right: .4rem; }
  .muted { color: #777; } .ok { color: #2e7d32; } .warn { color: #c62828; }
</style></head><body>
<h1>samebrain dashboard</h1>
<p class="muted">generated <span id="gen"></span> — rebuild with <code>node bin/dashboard.mjs</code></p>
<h2>Sessions per month (machine/agent)</h2><div id="sessions"></div>
<h2>Runs (smartloop + fleet)</h2><div id="runs"></div>
<h2>Memory index health</h2><div id="memory"></div>
<h2>Rule effectiveness</h2><div id="rules"></div>
<script>
const data = ${JSON.stringify(data).replace(/</g, '\\u003c')};
document.getElementById('gen').textContent = data.generated;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
{
  const el = document.getElementById('sessions');
  const monthKeys = Object.keys(data.months).sort().reverse();
  if (!monthKeys.length) el.innerHTML = '<p class="muted">no telemetry yet — records appear after agent sessions end</p>';
  for (const m of monthKeys) {
    const rows = Object.entries(data.months[m]).sort();
    const max = Math.max(...rows.map(([, n]) => n));
    el.innerHTML += '<h3>' + esc(m) + '</h3><table>' + rows.map(([k, n]) =>
      '<tr><td>' + esc(k) + '</td><td><span class="bar" style="width:' + (n / max) * 200 + 'px"></span>' + n + '</td></tr>').join('') + '</table>';
  }
}
{
  const el = document.getElementById('runs');
  if (!data.runs.length) el.innerHTML = '<p class="muted">no smartloop or fleet runs recorded yet</p>';
  else el.innerHTML = '<table><tr><th>slug</th><th>source</th><th>machine</th><th>outcome</th><th>iters</th><th>wall</th><th>verdicts</th></tr>'
    + data.runs.map((r) => '<tr><td>' + esc(r.slug) + '</td><td>' + esc(r.source ?? 'smartloop') + '</td><td>' + esc(r.machine) + '</td><td>' + esc(r.outcome)
      + '</td><td>' + esc(r.iters ?? '—') + '</td><td>' + (r.wall_s == null ? '—' : Math.round(r.wall_s / 60) + 'm') + '</td><td>'
      + esc((r.verdicts ?? []).map((v) => (v.lens ?? '?') + ':' + (v.verdict ?? '?')).join(' ') || '—') + '</td></tr>').join('') + '</table>';
}
{
  const el = document.getElementById('memory');
  const over = data.memory.lines > data.memory.cap;
  el.innerHTML = '<p>index: <strong class="' + (over ? 'warn' : 'ok') + '">' + data.memory.lines
    + ' lines</strong> (cap ' + data.memory.cap + ')' + (over ? ' — run /memory-gc' : '') + '</p>';
}
{
  const el = document.getElementById('rules');
  const r = data.rules;
  const corrections = data.memory.verify_flags + r.regrets;
  el.innerHTML = '<p>guardrails revision <code>' + esc(r.hash ?? 'n/a') + '</code>'
    + (r.changed ? ', last changed ' + esc(r.changed) + ' (' + r.revisions + ' revision' + (r.revisions === 1 ? '' : 's') + ')' : '')
    + '</p><p>correction pressure under this revision: <strong class="' + (corrections ? 'warn' : 'ok') + '">' + corrections + '</strong>'
    + ' (' + data.memory.verify_flags + ' unverified memory facts, ' + r.regrets + ' redone smartloop runs)'
    + (corrections ? ' — repeated corrections are rule-mine material (/rule-mine)' : '') + '</p>';
}
</script></body></html>
`;

writeFileSync(join(ROOT, 'dashboard.html'), html);
console.log(`dashboard: wrote dashboard.html (${runs.length} runs, ${Object.keys(months).length} months of sessions)`);
