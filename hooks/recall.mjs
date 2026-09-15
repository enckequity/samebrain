#!/usr/bin/env node
// Session-start memory recall: fast git pull (fail-silent), then emit the memory index plus,
// when Hindsight is configured, a bounded recall for this repository's bank and the global bank.
// Plain stdout for Claude Code / Codex (stdout -> context). `--cursor` wraps in
// Cursor's sessionStart JSON contract ({ additional_context }).
//   recall.mjs --refresh-recall <bank>   background mode: refresh one bank's cached recall, no output
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ageLabel, bankForCwd, claimRecall, formatResults, loadHindsight, readPages, readRecallCache, recall, releaseRecall,
  writeRecallCache,
} from './hindsight.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = homedir();

// The recall a session start sends for one bank: its own query for a repository, the cross-project
// query for the global bank.
const recallFor = (hs, bank, timeoutMs) => {
  const cfg = hs.settings.sessionRecall ?? {};
  const global = bank === hs.settings.globalBank;
  return recall(hs, bank, global ? (cfg.globalQuery ?? 'durable facts') : (cfg.query ?? '{bank}').replaceAll('{bank}', bank), {
    budget: cfg.budget, types: cfg.types, preferObservations: cfg.preferObservations, timeoutMs,
    maxTokens: global ? cfg.globalMaxTokens : cfg.maxTokens,
  });
};

const pagesFor = (hs, bank, timeoutMs) => readPages(hs, bank, (hs.settings.bankSetup?.pages ?? []).map((p) => p.name), {
  maxCharsPerPage: hs.settings.sessionPages?.maxCharsPerPage, timeoutMs,
});

// Background revalidation: refresh one bank's cached recall and knowledge pages for the next
// session. Single flight: skipped when another process already holds the bank.
if (process.argv.includes('--refresh-recall')) {
  const bank = process.argv[process.argv.indexOf('--refresh-recall') + 1];
  const hs = loadHindsight(root);
  if (hs && bank && claimRecall(bank)) {
    const timeoutMs = hs.settings.sessionRecall?.refreshTimeoutMs ?? 60000;
    try {
      const [results, pages] = await Promise.all([recallFor(hs, bank, timeoutMs), pagesFor(hs, bank, timeoutMs)]);
      writeRecallCache(bank, { results, pages });
    } catch { /* next session retries */ }
    releaseRecall(bank);
  }
  process.exit(0);
}
const display = root.startsWith(home)
  ? `~${root.slice(home.length).replaceAll('\\', '/')}`
  : root.replaceAll('\\', '/');

try {
  execFileSync('git', ['pull', '--rebase', '--autostash', '--quiet'], {
    cwd: root, timeout: 8000, stdio: ['ignore', 'ignore', 'ignore'],
  });
} catch {
  // Offline or a conflicted rebase. A rebase left in progress would wedge every later
  // git op on this repo — abort it and serve the local copy. Fail-silent.
  try {
    execFileSync('git', ['rebase', '--abort'], {
      cwd: root, timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch { /* no rebase in progress */ }
}

// Rebase pulls never fire the post-merge auto-render hook: re-render whenever HEAD
// has moved past the last rendered revision, so engine updates land on every machine
// at the next session start with no manual step. Best-effort, silent.
try {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim();
  let last = '';
  try { last = readFileSync(join(root, 'backups', '.last-render-head'), 'utf8').trim(); } catch { /* never rendered */ }
  if (head && head !== last) {
    execFileSync(process.execPath, [join(root, 'bin', 'render.mjs')], {
      cwd: root, timeout: 30000, stdio: ['ignore', 'ignore', 'ignore'],
    });
  }
} catch { /* render failed or no git — post-merge hook and manual render still cover it */ }

let index = '';
try {
  index = readFileSync(join(root, 'memory', 'MEMORY.md'), 'utf8');
} catch { process.exit(0); }

// Token-tax guards: the index is injected into every session of every agent.
// Lines keep it structural; bytes are what actually cost tokens — check both.
// The index is the always-injected core; the long tail lives in topics (and Hindsight, when enabled).
const CAP_LINES = 120;
const CAP_BYTES = 12000;
const factLines = index.split('\n').filter((l) => l.trim()).length;
const indexBytes = Buffer.byteLength(index, 'utf8');
const over = [];
if (factLines > CAP_LINES) over.push(`${factLines} non-blank lines (cap ${CAP_LINES})`);
if (indexBytes > CAP_BYTES) over.push(`${indexBytes} bytes (cap ${CAP_BYTES})`);
const warn = over.length
  ? `\n\nWARNING: memory index over budget: ${over.join('; ')}. Prune now: merge stale facts into memory/topics/*.md or delete them.`
  : '';

// Hook payloads carry the session directory (Claude/Codex: cwd, Cursor: workspace_roots).
let payload = {};
if (!process.stdin.isTTY) {
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/odd payload */ }
}
const cwd = process.env.SAMEBRAIN_CWD ?? payload.cwd ?? payload.workspace_roots?.[0] ?? process.cwd();

// Hindsight, cache first: each bank's last knowledge pages and recall are injected immediately
// with their age, and a detached refresher revalidates stale banks for the next session. Only a
// bank with no cache at all waits for a live read, under a short budget. The index is always
// injected, and one live read per bank runs at a time on this machine.
const hs = loadHindsight(root);
let recalled = '';
if (hs) {
  const cfg = hs.settings.sessionRecall ?? {};
  const bank = bankForCwd(cwd, hs.settings);
  const banks = bank === hs.settings.globalBank ? [bank] : [bank, hs.settings.globalBank];
  const cached = new Map(banks.map((b) => [b, readRecallCache(b)]));
  const live = new Map();
  const held = banks.filter((b) => !cached.get(b) && claimRecall(b));
  if (held.length) {
    const timeoutMs = cfg.refreshTimeoutMs ?? 60000; // the race below decides; no per-request abort
    try {
      await Promise.race([
        Promise.allSettled(held.map(async (b) => {
          const [results, pages] = await Promise.all([recallFor(hs, b, timeoutMs), pagesFor(hs, b, timeoutMs)]);
          live.set(b, { results, pages });
        })),
        new Promise((res) => { setTimeout(res, cfg.coldTimeoutMs ?? 1500).unref(); }),
      ]);
    } catch { /* never block session start on memory */ }
  }
  const pageBlocks = [];
  const sections = [];
  const seen = new Set();
  for (const b of banks) {
    const fresh = live.get(b);
    const stale = cached.get(b);
    if (fresh) {
      try { writeRecallCache(b, fresh); } catch { /* cache is best-effort */ }
    }
    if (held.includes(b)) releaseRecall(b);
    const source = fresh?.results.length || fresh?.pages.length ? fresh : stale;
    const label = source === fresh ? 'live' : stale ? `cached, recalled ${ageLabel(stale.at)}` : '';
    // Revalidate a bank whose live read missed the budget, or whose cache has aged out.
    const due = (held.includes(b) && !fresh) || (stale && Date.now() - Date.parse(stale.at) > (cfg.revalidateAfterMs ?? 300000));
    if (due && process.env.SAMEBRAIN_HINDSIGHT_REVALIDATE !== '0') {
      try {
        spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh-recall', b], { detached: true, stdio: 'ignore' }).unref();
      } catch { /* revalidation is best-effort */ }
    }
    if (!source) continue;
    for (const p of source.pages) pageBlocks.push(`### ${p.name} (${b})\n${p.body}`);
    const facts = source.results.filter((r) => !seen.has(r.text) && seen.add(r.text));
    if (facts.length) sections.push(`\n## Recalled from ${b} (${label})\n${formatResults(facts)}`);
  }
  const pages = pageBlocks.join('\n\n');
  if (pages || sections.length) {
    recalled = `\n\n<hindsight_memories source="samebrain" bank="${bank}" global-bank="${hs.settings.globalBank}" search="node ${display}/bin/memory-search.mjs '<query>'">`
      + `${pages ? `\n## Knowledge pages\n${pages}` : ''}${sections.join('')}\n</hindsight_memories>`;
  }
  // Delta pages drift over many incremental refreshes; bin/hindsight-banks.mjs --maintain clears and
  // rebuilds them when due (48h). Detached so the session never waits on it.
  try {
    const stamp = join(homedir(), '.hindsight', 'samebrain-pages-maintained.json');
    // The stamp is written when the pages are set up, so fresh pages are never cleared.
    const due = existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs > (hs.settings.bankSetup?.clearEveryHours ?? 48) * 3600000;
    if (due && hs.settings.bankSetup && process.env.SAMEBRAIN_HINDSIGHT_MAINTAIN !== '0') {
      spawn(process.execPath, [join(root, 'bin', 'hindsight-banks.mjs'), '--maintain'], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* maintenance is best-effort */ }
}

const body =
  `<shared-agent-memory source="${display}/memory" detail-files="memory/topics/*.md">\n${index.trim()}${warn}\n</shared-agent-memory>${recalled}`;

if (process.argv.includes('--cursor')) {
  process.stdout.write(JSON.stringify({ additional_context: body }));
} else {
  process.stdout.write(body);
}
// Pending fetch sockets must not hold the hook open past the output.
process.exit(0);
