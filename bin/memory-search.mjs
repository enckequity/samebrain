#!/usr/bin/env node
// On-demand long-tail memory search against Hindsight: this repository's bank plus the global bank.
//   node bin/memory-search.mjs "<query>" [--cwd <dir>] [--bank <id>] [--json]
// Exit 0 = results printed, 1 = nothing matched, 3 = Hindsight not configured or unreachable
// (callers such as the opencode plugin fall back to the local topic search on 3).
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankForCwd, bankPath, formatResults, hindsightRequest, loadHindsight } from '../hooks/hindsight.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const query = args.filter((a, i) => !a.startsWith('--') && !['--cwd', '--bank'].includes(args[i - 1])).join(' ').trim();
if (!query) {
  console.error('usage: memory-search.mjs "<query>" [--cwd <dir>] [--bank <id>] [--json]');
  process.exit(2);
}

const hs = loadHindsight(root);
if (!hs) {
  console.error('memory-search: Hindsight is not enabled (set "enabled": true in global/hindsight.json and HINDSIGHT_API_URL + HINDSIGHT_API_KEY)');
  process.exit(3);
}

const cfg = hs.settings.search ?? {};
const bank = flag('--bank') ?? bankForCwd(flag('--cwd') ?? process.cwd(), hs.settings);
const banks = [...new Set([bank, hs.settings.globalBank])];

const search = async (id) => {
  const body = { query: query.slice(0, 800), budget: cfg.budget ?? 'mid', max_tokens: cfg.maxTokens ?? 1500 };
  if (cfg.types?.length) body.types = cfg.types;
  if (cfg.preferObservations) body.prefer_observations = true;
  const r = await hindsightRequest(hs, 'POST', `${bankPath(id)}/memories/recall`, body, cfg.timeoutMs ?? 12000);
  // A bank nobody has written to yet is empty, not an outage.
  if (r.status === 404) return { id, results: [] };
  if (!r.ok) throw new Error(`${id}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return { id, results: Array.isArray(r.json?.results) ? r.json.results : [] };
};

let found;
try {
  found = await Promise.all(banks.map(search));
} catch (err) {
  console.error(`memory-search: Hindsight unavailable — ${err.message}`);
  process.exit(3);
}

if (args.includes('--json')) {
  process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
} else {
  for (const { id, results } of found) {
    if (results.length) process.stdout.write(`## bank ${id}\n${formatResults(results)}\n\n`);
  }
}
process.exit(found.some((f) => f.results.length) ? 0 : 1);
