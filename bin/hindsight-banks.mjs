#!/usr/bin/env node
// Apply global/hindsight.json bankSetup to the Hindsight server: knowledge pages and directives on
// every listed dev bank. Idempotent: creates what is missing, patches what drifted, never deletes.
//   node bin/hindsight-banks.mjs                       apply
//   node bin/hindsight-banks.mjs --check               report drift, change nothing
//   node bin/hindsight-banks.mjs --refresh <bank>/<page name>   rebuild one page now and print it
//   node bin/hindsight-banks.mjs --maintain            clear + rebuild delta pages (drift), when due
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankPath, hindsightRequest, loadHindsight } from '../hooks/hindsight.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const MAINTAIN = argv.includes('--maintain');
const REFRESH = argv.includes('--refresh') ? argv[argv.indexOf('--refresh') + 1] : null;
const STAMP = join(homedir(), '.hindsight', 'samebrain-pages-maintained.json');
const fail = (msg) => { console.error(`hindsight-banks: ${msg}`); process.exit(1); };

const hs = loadHindsight(ROOT);
if (!hs) fail('Hindsight is not enabled: set "enabled": true in global/hindsight.json and HINDSIGHT_API_URL + HINDSIGHT_API_KEY (environment or secrets.env)');
const setup = hs.settings.bankSetup;
if (!setup) fail('global/hindsight.json has no bankSetup');

const call = async (method, path, body, timeoutMs = 30000) => {
  const r = await hindsightRequest(hs, method, path, body, timeoutMs);
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
};

// Daily refresh at a minute and hour hashed from bank + page, so refreshes never pile up at once.
function staggeredDailyCron(bank, name) {
  const h = createHash('sha256').update(`${bank}/${name}`).digest();
  return `${h[0] % 60} ${h[1] % 24} * * *`;
}

const triggerFor = (bank, page) => ({
  mode: page.mode,
  fact_types: ['observation'],
  exclude_mental_models: true,
  include_chunks: false,
  refresh_after_consolidation: false,
  refresh_cron: staggeredDailyCron(bank, page.name),
});

async function pageNodes(bank) {
  const tree = await call('GET', `${bankPath(bank)}/knowledge-base/tree`);
  const flat = [];
  const walk = (nodes) => { for (const n of nodes ?? []) { flat.push(n); walk(n.children); } };
  walk(tree.roots);
  return flat.filter((n) => n.kind === 'page');
}

async function applyBank(bank) {
  const base = bankPath(bank);
  const changes = [];
  const nodes = await pageNodes(bank);
  for (const page of setup.pages) {
    const want = { source_query: page.source_query, max_tokens: setup.pageMaxTokens, trigger: triggerFor(bank, page) };
    const have = nodes.find((n) => n.name === page.name);
    if (!have) {
      changes.push(`create page "${page.name}"`);
      if (!CHECK) await call('POST', `${base}/knowledge-base/pages`, { name: page.name, tags: [], ...want });
      continue;
    }
    const drift = have.description !== want.source_query || (have.tags ?? []).length
      || Object.entries(want.trigger).some(([k, v]) => JSON.stringify(have.trigger?.[k] ?? null) !== JSON.stringify(v));
    if (drift) {
      changes.push(`update page "${page.name}"`);
      if (!CHECK) await call('PATCH', `${base}/knowledge-base/nodes/${encodeURIComponent(have.id)}`, { tags: [], ...want });
    }
  }
  const directives = (await call('GET', `${base}/directives?limit=100`)).items ?? [];
  for (const d of setup.directives) {
    const want = { name: d.name, content: d.content, priority: d.priority, is_active: true, tags: [] };
    const have = directives.find((x) => x.name === d.name);
    if (!have) {
      changes.push(`create directive "${d.name}"`);
      if (!CHECK) await call('POST', `${base}/directives`, want);
    } else if (have.content !== want.content || have.priority !== want.priority || !have.is_active || (have.tags ?? []).length) {
      changes.push(`update directive "${d.name}"`);
      if (!CHECK) await call('PATCH', `${base}/directives/${encodeURIComponent(have.id)}`, want);
    }
  }
  return changes;
}

async function waitFor(bank, op, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = 'pending';
  while (Date.now() < deadline) {
    status = (await call('GET', `${bankPath(bank)}/operations/${encodeURIComponent(op)}`)).status;
    if (['completed', 'failed', 'cancelled', 'not_found'].includes(status)) break;
    await new Promise((r) => { setTimeout(r, 5000); });
  }
  return status;
}

async function refresh(target) {
  const slash = target.indexOf('/');
  const bank = target.slice(0, slash);
  const name = target.slice(slash + 1);
  if (slash < 1 || !name) fail('--refresh expects <bank>/<page name>');
  const node = (await pageNodes(bank)).find((n) => n.name === name);
  if (!node) fail(`no page "${name}" in ${bank}`);
  const { operation_id: op } = await call('POST', `${bankPath(bank)}/mental-models/${encodeURIComponent(node.mental_model_id)}/refresh`, {});
  const status = await waitFor(bank, op, 15 * 60000);
  const page = await call('GET', `${bankPath(bank)}/knowledge-base/pages/${encodeURIComponent(node.id)}`);
  console.log(`refresh ${bank}/${name}: operation ${op} ${status}; timestamp=${page.timestamp ?? '-'}`);
  console.log(page.body || '(empty)');
  process.exit(status === 'completed' ? 0 : 1);
}

// Delta pages accumulate drift over many incremental refreshes; clearing forces the next refresh to
// rebuild from all facts (mental-models docs: "periodic clear + refresh, e.g. every 48 hours").
// The stamp is claimed first so concurrent session starts do not run it twice.
async function maintain() {
  mkdirSync(dirname(STAMP), { recursive: true });
  writeFileSync(STAMP, `${JSON.stringify({ started: new Date().toISOString() })}\n`);
  for (const bank of setup.banks) {
    try {
      const nodes = await pageNodes(bank);
      for (const page of setup.pages.filter((p) => p.mode === 'delta')) {
        const node = nodes.find((n) => n.name === page.name);
        if (!node) continue;
        const mm = encodeURIComponent(node.mental_model_id);
        await call('POST', `${bankPath(bank)}/mental-models/${mm}/clear`, {});
        await call('POST', `${bankPath(bank)}/mental-models/${mm}/refresh`, {});
        console.log(`${bank}: cleared and rebuilding "${page.name}"`);
      }
    } catch (err) {
      console.error(`${bank}: ${err.message}`);
    }
  }
  process.exit(0);
}

if (REFRESH) await refresh(REFRESH);
if (MAINTAIN) await maintain();

let drifted = 0;
for (const bank of setup.banks) {
  try {
    const changes = await applyBank(bank);
    drifted += changes.length;
    console.log(`${bank}: ${changes.length ? changes.join('; ') : 'in sync'}`);
  } catch (err) {
    drifted += 1;
    console.error(`${bank}: ${err.message}`);
  }
}
// Freshly built pages are the drift-free baseline: start the maintenance clock now.
if (!CHECK && !existsSync(STAMP)) {
  mkdirSync(dirname(STAMP), { recursive: true });
  writeFileSync(STAMP, `${JSON.stringify({ started: new Date().toISOString() })}\n`);
}
process.exit(CHECK && drifted ? 1 : 0);
