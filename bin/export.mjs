#!/usr/bin/env node
// Export the smartloop trace corpus as an eval dataset. Stdout by default.
//   node bin/export.mjs --format deepeval       JSON array of test cases
//   node bin/export.mjs --format openai-evals   JSONL, one sample per line
//   node bin/export.mjs --format text           plain tab-separated lines
//   [--out <file>]                              write to a file instead of stdout
//
// Sources: telemetry/*/smartloop-runs.jsonl (the run summaries). When the state
// dir ($SMARTLOOP_DIR or ~/.smartloop) still holds a run's state.md, its Contract
// goal line becomes the sample input; otherwise the slug stands in.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const format = arg('--format') ?? 'text';
const FORMATS = ['deepeval', 'openai-evals', 'text'];
if (!FORMATS.includes(format)) {
  console.error(`export: unknown format "${format}" (expected ${FORMATS.join(' | ')})`);
  process.exit(1);
}

const stateDir = process.env.SMARTLOOP_DIR ?? join(homedir(), '.smartloop');
const goalFor = (slug) => {
  const p = join(stateDir, slug, 'state.md');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').match(/^Goal:\s*(.+)$/m)?.[1]?.trim() ?? null;
};

const runs = [];
const telemetryRoot = join(ROOT, 'telemetry');
if (existsSync(telemetryRoot)) {
  for (const machine of readdirSync(telemetryRoot)) {
    const p = join(telemetryRoot, machine, 'smartloop-runs.jsonl');
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      try { runs.push({ machine, ...JSON.parse(line) }); } catch { /* skip bad line */ }
    }
  }
}

const samples = runs.map((r) => ({
  input: goalFor(r.slug) ?? r.slug,
  output: r.outcome,
  metadata: { slug: r.slug, machine: r.machine, iters: r.iters, wall_s: r.wall_s, verdicts: r.verdicts ?? [], ts: r.ts },
}));

let out;
if (format === 'deepeval') {
  out = `${JSON.stringify(samples.map((s) => ({
    input: s.input, actual_output: s.output, expected_output: 'done', metadata: s.metadata,
  })), null, 2)}\n`;
} else if (format === 'openai-evals') {
  out = samples.map((s) => JSON.stringify({
    input: [{ role: 'user', content: s.input }], ideal: 'done', metadata: s.metadata,
  })).join('\n') + (samples.length ? '\n' : '');
} else {
  out = samples.map((s) => `${s.metadata.slug}\t${s.output}\t${s.metadata.iters}\t${s.metadata.wall_s}`).join('\n')
    + (samples.length ? '\n' : '');
}

const outFile = arg('--out');
if (outFile) {
  writeFileSync(outFile, out);
  console.log(`export: wrote ${samples.length} sample(s) to ${outFile} (${format})`);
} else {
  process.stdout.write(out);
}
