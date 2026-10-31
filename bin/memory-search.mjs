#!/usr/bin/env node
// On-demand long-tail memory search: Hindsight (this repository's bank plus the global bank) when
// it is configured and reachable, otherwise matching lines in memory/MEMORY.md and memory/topics/*.md.
//   node bin/memory-search.mjs "<query>" [--cwd <dir>] [--bank <id>] [--json]
// Exit 0 = results printed, 1 = nothing matched, 2 = usage. Hindsight being retired, unconfigured or
// unreachable is not an error: the local topic search answers instead (bank id "topics").
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const LOCAL_LIMIT = 20;
// Score each line by how many distinct query terms (3+ chars) it contains; best lines first.
const searchTopics = () => {
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((w) => w.length >= 3))];
  const dir = join(root, 'memory');
  const topics = join(dir, 'topics');
  const files = [
    ...(existsSync(join(dir, 'MEMORY.md')) ? ['MEMORY.md'] : []),
    ...(existsSync(topics) ? readdirSync(topics).filter((f) => f.endsWith('.md')).sort().map((f) => `topics/${f}`) : []),
  ];
  const hits = [];
  for (const file of files) {
    readFileSync(join(dir, file), 'utf8').split('\n').forEach((line, i) => {
      const lower = line.toLowerCase();
      const score = terms.filter((t) => lower.includes(t)).length;
      if (score) hits.push({ score, text: `memory/${file}:${i + 1}: ${line.trim().slice(0, 400)}` });
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, LOCAL_LIMIT).map(({ text }) => ({ text }));
};

const searchHindsight = async (hs) => {
  const cfg = hs.settings.search ?? {};
  const bank = flag('--bank') ?? bankForCwd(flag('--cwd') ?? process.cwd(), hs.settings);
  const banks = [...new Set([bank, hs.settings.globalBank])];
  const search = async (id) => {
    const body = { query: query.slice(0, 800), budget: cfg.budget ?? 'mid', max_tokens: cfg.maxTokens ?? 1500 };
    if (cfg.types?.length) body.types = cfg.types;
    if (cfg.preferObservations) body.prefer_observations = true;
    const r = await hindsightRequest(hs, 'POST', `${bankPath(id)}/memories/recall`, body, cfg.timeoutMs ?? 4000);
    // A bank nobody has written to yet is empty, not an outage.
    if (r.status === 404) return { id, results: [] };
    if (!r.ok) throw new Error(`${id}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    return { id, results: Array.isArray(r.json?.results) ? r.json.results : [] };
  };
  return Promise.all(banks.map(search));
};

const hs = loadHindsight(root);
let found;
if (hs) {
  try {
    found = await searchHindsight(hs);
  } catch (err) {
    console.error(`memory-search: Hindsight unavailable (${err.message}); searched memory/topics instead`);
  }
}
found ??= [{ id: 'topics', results: searchTopics() }];

if (args.includes('--json')) {
  process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
} else {
  for (const { id, results } of found) {
    if (results.length) process.stdout.write(`## bank ${id}\n${formatResults(results)}\n\n`);
  }
}
// Let pending stdout writes and HTTP handles finish before exiting.
process.exitCode = found.some((f) => f.results.length) ? 0 : 1;
