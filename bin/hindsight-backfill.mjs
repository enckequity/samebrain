#!/usr/bin/env node
// Backfill existing memory into self-hosted Hindsight. Idempotent and spend-capped.
//   node bin/hindsight-backfill.mjs --dry-run              estimate only; no network
//   node bin/hindsight-backfill.mjs [--max-usd 40]         send (stops before the cap is crossed)
// Options:
//   --sources memory,claude-memory,codex-memory,claude-sessions,codex-sessions   (default: all)
//   --since-days 21          session transcripts modified within this window
//   --resend                 re-retain backfill-owned documents even when unchanged (repairs a
//                            run sent with older fields; live-hook documents are still never touched)
//   --samebrain-dir <dir>    shared memory repo to read (default: this repo)
//   --bank <id>              only documents routed to this bank
//   --limit <n>              at most n documents after filtering (smoke runs)
//   --verbose                list every document
//
// Routing: shared/auto/Codex memory → the global bank; a session transcript → the bank its
// recorded working directory resolves to: its repository name exactly as the live plugins name it
// (worktrees share one bank), or the global bank outside a repository. Sessions whose directory no longer exists resolve through their
// nearest existing ancestor only when that ancestor is inside a repository (Codex sessions also by
// their recorded git remote); others are skipped.
//
// Ordering: Hindsight reconciles contradictions by time, so every item carries its original time
// (session start; memory file = last commit time, or mtime when uncommitted/untracked) and items are
// sent oldest → newest with curated memory files LAST, so current curated truth is the newest
// evidence. When the cap cannot cover everything, the oldest sessions are dropped, never curated files.
//
// Idempotency: every document has a stable id (conversation:<session> matches the live
// coding-agents write-back, so a resumed session replaces rather than duplicates) and carries
// metadata.content_hash. Unchanged content is skipped via a local ledger and the server's copy;
// a document the live hooks already own is never overwritten.
//
// Content is scrubbed client-side with the same patterns as Hindsight's memory_defense. The server
// enforces redaction as tenant config (clients cannot read or change it), so before sending anything
// a canary with a fake key is retained into a throwaway bank and the run aborts unless the stored
// document, chunks and memories come back without the literal.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bankPath, hindsightRequest, loadHindsight, loadSettings, repoName, scrub,
} from '../hooks/hindsight.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = homedir();
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const DRY = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const MAX_USD = Number(opt('--max-usd', '40'));
const SINCE_DAYS = Number(opt('--since-days', '21'));
const RESEND = argv.includes('--resend');
const ALL_SOURCES = ['memory', 'claude-memory', 'codex-memory', 'claude-sessions', 'codex-sessions'];
const SOURCES = opt('--sources', ALL_SOURCES.join(',')).split(',').filter(Boolean);
const ONLY_BANK = opt('--bank');
const LIMIT = opt('--limit') ? Number(opt('--limit')) : Infinity;
const SAMEBRAIN_DIR = opt('--samebrain-dir', ROOT);
const LEDGER = join(HOME, '.hindsight', 'samebrain-backfill.json');

for (const s of SOURCES) if (!ALL_SOURCES.includes(s)) fail(`unknown source "${s}" (valid: ${ALL_SOURCES.join(', ')})`);
if (!Number.isFinite(MAX_USD) || MAX_USD <= 0) fail('--max-usd must be a positive number');
if (!Number.isFinite(SINCE_DAYS) || SINCE_DAYS <= 0) fail('--since-days must be a positive number');

function fail(msg) {
  console.error(`hindsight-backfill: ${msg}`);
  process.exit(1);
}

// ---- cost model -----------------------------------------------------------------------------
// Assumes a low-cost extraction model on the server: $0.30/1M input, $1.20/1M output, output ≈ 20% of input.
// Hindsight splits content into ~3000-char chunks and sends each with a ~2000-token extraction
// prompt (concise mode, v0.10.0); consolidation into observations adds roughly half again.
const PRICING = { inPerM: 0.30, outPerM: 1.20, outputRatio: 0.2 };
const CHARS_PER_TOKEN = 4;
const CHUNK_CHARS = 3000;
const PROMPT_TOKENS_PER_CHUNK = 2000;
const CONSOLIDATION_FACTOR = 1.5;

function estimate(chars) {
  const contentTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const chunks = Math.max(1, Math.ceil(chars / CHUNK_CHARS));
  const input = Math.ceil((contentTokens + chunks * PROMPT_TOKENS_PER_CHUNK) * CONSOLIDATION_FACTOR);
  const output = Math.ceil(input * PRICING.outputRatio);
  const usd = (input * PRICING.inPerM + output * PRICING.outPerM) / 1e6;
  return { contentTokens, input, output, usd };
}

// ---- helpers --------------------------------------------------------------------------------
const hash = (s) => createHash('sha256').update(s).digest('hex');
// Deterministic RFC 4122-shaped (v5-style) UUID from a string.
const uuidFrom = (s) => {
  const h = createHash('sha256').update(s).digest('hex').slice(0, 32).split('');
  h[12] = '5';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};
const readJsonl = (file) => {
  const out = [];
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object') out.push(v);
    } catch { /* truncated line */ }
  }
  return out;
};
const walk = (dir, keep, acc = []) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, acc);
    else if (e.isFile() && keep(p)) acc.push(p);
  }
  return acc;
};
const cutoff = Date.now() - SINCE_DAYS * 86400000;
const recent = (p) => { try { return statSync(p).mtimeMs >= cutoff; } catch { return false; } };
const mtimeIso = (p) => new Date(statSync(p).mtimeMs).toISOString();
// Last commit time for a tracked, unmodified file; otherwise its mtime (uncommitted edits are newer).
function fileTimestamp(file) {
  const git = (args) => execFileSync('git', ['-C', dirname(file), ...args], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    if (!git(['status', '--porcelain', '--', basename(file)])) {
      const committed = git(['log', '-1', '--format=%cI', '--', basename(file)]);
      if (committed) return new Date(committed).toISOString();
    }
  } catch { /* not a repository */ }
  return mtimeIso(file);
}

// Blocks agents inject into their own transcripts (upstream stripInjectedMemory plus samebrain's).
const INJECTED_RE = /<(hook_prompt|task-notification|system-reminder|hindsight_memory|hindsight_memories|hindsight_bank|relevant_memories|user_feedback|hindsight_knowledge|hindsight_knowledge_refresh|shared-agent-memory|local-command-stdout|local-command-caveat)\b[\s\S]*?<\/\1>/g;
const clean = (s) => s.replace(INJECTED_RE, '').trim();

const TARGET_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url', 'name', 'id'];
function actionLine(tool, input) {
  let target = '';
  if (input && typeof input === 'object') {
    for (const k of TARGET_KEYS) {
      if (typeof input[k] === 'string' && input[k].trim()) { target = input[k].trim().split('\n')[0]; break; }
    }
  }
  if (target.length > 100) target = `${target.slice(0, 100)}…`;
  return target ? `${tool} ${target}` : tool;
}

// Same JSONL rendering as the live write-back (coding-agents chat.ts renderSessionJsonl).
function renderSession(refId, turns, startTs) {
  return [{ role: 'system', content: `REF-ID: ${refId}`, timestamp: startTs }, ...turns]
    .map((t) => JSON.stringify(t))
    .join('\n');
}

// ---- bank routing for recorded session directories ------------------------------------------
let settings;
const bankCache = new Map();
function bankForRecordedCwd(cwd) {
  if (!cwd) return null;
  if (bankCache.has(cwd)) return bankCache.get(cwd);
  let bank = null;
  if (existsSync(cwd)) {
    // Outside a repository the live plugins fall back to the directory basename, which scatters
    // one-off scratch and app-thread directories into single-session banks; history goes global.
    bank = repoName(cwd) ?? settings.globalBank;
  } else {
    // A deleted directory (usually a removed worktree) is attributable only when its nearest
    // surviving ancestor is inside a repository; a plain parent directory would be a guess.
    let dir = dirname(cwd);
    while (dir !== dirname(dir) && !existsSync(dir)) dir = dirname(dir);
    bank = repoName(dir);
  }
  bankCache.set(cwd, bank);
  return bank;
}

// ---- sources --------------------------------------------------------------------------------
const displayPath = (file) => (file.startsWith(HOME) ? `~${file.slice(HOME.length)}` : file);

const MEMORY_CONTEXT = {
  'samebrain-memory': 'Curated shared memory file that the user\'s coding agents maintain in samebrain (current standing facts, rules and gotchas)',
  'claude-memory': 'Curated Claude Code auto-memory file for the user (current standing facts, rules and gotchas)',
  'codex-memory': 'Curated Codex memory summary for the user (consolidated from past Codex sessions)',
};

function markdownDoc(kind, id, file, title, text) {
  return {
    source: kind,
    curated: true,
    bank: settings.globalBank,
    document_id: id,
    context: MEMORY_CONTEXT[kind] ?? title,
    content: scrub(text),
    timestamp: fileTimestamp(file),
    update_mode: 'replace',
    tags: ['source:memory-file', `memory:${kind}`],
    metadata: { source: 'memory-file', memory_kind: kind, path: displayPath(file) },
  };
}

function samebrainMemory() {
  const dir = join(SAMEBRAIN_DIR, 'memory');
  const files = [join(dir, 'MEMORY.md'), ...walk(join(dir, 'topics'), (p) => p.endsWith('.md'))].filter(existsSync);
  return files.map((f) => markdownDoc('samebrain-memory', `samebrain:memory/${relative(dir, f)}`, f,
    'samebrain shared cross-agent memory', `# ${relative(dir, f)}\n\n${readFileSync(f, 'utf8')}`));
}

function claudeAutoMemory() {
  const dir = join(HOME, '.claude', 'projects', `-${HOME.slice(1).replaceAll('/', '-')}`, 'memory');
  return walk(dir, (p) => p.endsWith('.md')).map((f) => markdownDoc('claude-memory', `claude-memory:${relative(dir, f)}`, f,
    'Claude Code auto-memory', readFileSync(f, 'utf8')));
}

// ~/.codex/memories is read-only here. MEMORY.md holds "# Task Group:" sections and
// memory_summary.md "## " sections; each section becomes one document so an edit re-extracts only it.
function codexMemory() {
  const dir = join(HOME, '.codex', 'memories');
  const docs = [];
  for (const [name, re] of [['MEMORY.md', /^(?=# Task Group:)/m], ['memory_summary.md', /^(?=## )/m]]) {
    const f = join(dir, name);
    if (!existsSync(f)) continue;
    const sections = readFileSync(f, 'utf8').split(re).map((s) => s.trim()).filter((s) => s.length > 40);
    sections.forEach((section, i) => {
      const heading = section.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80);
      const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `section-${i}`;
      docs.push(markdownDoc('codex-memory', `codex-memory:${name}#${slug}`, f, 'Codex memory', section));
    });
  }
  // Duplicate headings would collide on one id; keep them distinct and stable by order.
  const seen = new Map();
  for (const d of docs) {
    const n = seen.get(d.document_id) ?? 0;
    seen.set(d.document_id, n + 1);
    if (n) d.document_id = `${d.document_id}-${n + 1}`;
  }
  return docs;
}

function sessionDoc(harness, file, sessionId, cwd, turns, stats, repoHint = null) {
  if (!sessionId || turns.length < 2 || !turns.some((t) => t.role === 'user')) { stats.empty += 1; return null; }
  if ((settings.backfill?.excludeSessionIds ?? []).includes(sessionId)) { stats.excluded += 1; return null; }
  const bank = bankForRecordedCwd(cwd) ?? repoHint;
  if (!bank) { stats.unattributed += 1; return null; }
  const refId = `conversation:${sessionId}`;
  // Session start; a transcript without per-turn times falls back to its file time, never "now".
  const startTs = turns.find((t) => t.timestamp)?.timestamp ?? mtimeIso(file);
  const kind = harness === 'codex' ? 'codex-session' : 'claude-session';
  return {
    source: kind,
    bank,
    document_id: refId,
    context: `${harness === 'codex' ? 'Codex CLI' : 'Claude Code'} session transcript between the user and a coding agent ${bank === settings.globalBank ? 'outside any repository' : `in the ${bank} repository`}`,
    content: scrub(renderSession(refId, turns, startTs)),
    timestamp: startTs,
    strategy: 'conversation',
    update_mode: 'replace',
    tags: ['source:chat', `harness:${harness}`, `source:${kind}`],
    metadata: { source: 'chat', backfill_source: kind, session_id: sessionId, ref_id: refId, harness, path: displayPath(file) },
  };
}

function claudeSessions(stats) {
  const root = join(HOME, '.claude', 'projects');
  const files = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(root, d.name))) {
      const p = join(root, d.name, f);
      if (f.endsWith('.jsonl') && recent(p)) files.push(p);
    }
  }
  return files.map((file) => {
    let cwd = null;
    let sessionId = basename(file, '.jsonl');
    const turns = [];
    for (const line of readJsonl(file)) {
      if (line.type !== 'user' && line.type !== 'assistant') continue;
      cwd ??= typeof line.cwd === 'string' ? line.cwd : null;
      if (typeof line.sessionId === 'string') sessionId = line.sessionId;
      if (line.isMeta || line.isSidechain || line.isCompactSummary || !line.message) continue;
      const content = line.message.content;
      const ts = typeof line.timestamp === 'string' ? { timestamp: line.timestamp } : {};
      if (typeof content === 'string') {
        const text = clean(content);
        if (text) turns.push({ role: line.type, content: text, ...ts });
        continue;
      }
      if (!Array.isArray(content)) continue;
      const text = clean(content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n'));
      if (text) turns.push({ role: line.type, content: text, ...ts });
      for (const b of content) {
        if (b?.type === 'tool_use' && typeof b.name === 'string') turns.push({ role: 'action', content: actionLine(b.name, b.input), ...ts });
      }
    }
    return sessionDoc('claude-code', file, sessionId, cwd, turns, stats);
  }).filter(Boolean);
}

function codexSessions(stats) {
  const files = walk(join(HOME, '.codex', 'sessions'), (p) => p.endsWith('.jsonl') && recent(p));
  return files.map((file) => {
    let cwd = null;
    let sessionId = null;
    let repoHint = null;
    const turns = [];
    for (const line of readJsonl(file)) {
      const p = line.payload;
      if (!p || typeof p !== 'object') continue;
      if (line.type === 'session_meta') {
        cwd ??= typeof p.cwd === 'string' ? p.cwd : null;
        sessionId ??= typeof p.id === 'string' ? p.id : null;
        // Codex records the remote; it names the repository when the worktree is gone.
        const remote = p.git?.repository_url;
        if (typeof remote === 'string') repoHint ??= basename(remote.replace(/\/+$/, '')).replace(/\.git$/, '') || null;
        continue;
      }
      if (line.type !== 'response_item') continue;
      const ts = typeof line.timestamp === 'string' ? { timestamp: line.timestamp } : {};
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const text = clean((p.content ?? []).filter((c) => typeof c?.text === 'string').map((c) => c.text).join('\n'));
        if (!text) continue;
        if (p.role === 'user' && (text.startsWith('# AGENTS.md instructions for ') || text.startsWith('<environment_context>'))) continue;
        turns.push({ role: p.role, content: text, ...ts });
      } else if (p.type === 'function_call' && typeof p.name === 'string') {
        let input;
        try { input = JSON.parse(p.arguments || ''); } catch { input = undefined; }
        turns.push({ role: 'action', content: actionLine(p.name, input), ...ts });
      }
    }
    return sessionDoc('codex', file, sessionId, cwd, turns, stats, repoHint);
  }).filter(Boolean);
}

// ---- server ---------------------------------------------------------------------------------
async function withRetry(fn) {
  for (let attempt = 0; ; attempt += 1) {
    const r = await fn();
    if (r.status !== 429 && r.status < 500) return r;
    if (attempt >= 3) return r;
    await new Promise((res) => { setTimeout(res, 2000 * 2 ** attempt); });
  }
}

// A fake key in the shape of an Anthropic key: matched by memory_defense, never a real secret.
const CANARY_SECRET = 'sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE0000';
const CANARY_POLL_MS = 2000;
const CANARY_TIMEOUT_MS = Number(process.env.SAMEBRAIN_CANARY_TIMEOUT_MS ?? 180000);

// Proves server-side redaction end to end before any real content leaves the machine. Sent raw
// (no client scrub), processed fully, read back from every stored surface, then the bank is deleted.
// Returns null when the literal is gone, else the reason to abort.
async function redactionCanary(hs) {
  const bank = `samebrain-canary-${Date.now()}`;
  const base = bankPath(bank);
  try {
    const retained = await withRetry(() => hindsightRequest(hs, 'POST', `${base}/memories`, {
      items: [{ content: `Redaction canary. The deploy key is ${CANARY_SECRET} and must never be stored.`, document_id: 'canary', context: 'samebrain redaction canary' }],
      async: true,
    }, 30000));
    if (!retained.ok) return `canary retain failed (HTTP ${retained.status} ${retained.text.slice(0, 200)})`;
    const op = retained.json?.operation_id ?? retained.json?.operation_ids?.[0];
    if (!op) return 'canary retain returned no operation id';
    const deadline = Date.now() + CANARY_TIMEOUT_MS;
    let status = 'pending';
    while (Date.now() < deadline) {
      const r = await withRetry(() => hindsightRequest(hs, 'GET', `${base}/operations/${encodeURIComponent(op)}`));
      status = r.json?.status ?? `HTTP ${r.status}`;
      if (status === 'completed') break;
      if (['failed', 'cancelled', 'not_found'].includes(status) || (!r.ok && r.status !== 404)) {
        return `canary operation ${status}${r.json?.error_message ? `: ${r.json.error_message}` : ''} — redaction unverified`;
      }
      await new Promise((res) => { setTimeout(res, CANARY_POLL_MS); });
    }
    if (status !== 'completed') return `canary still ${status} after ${CANARY_TIMEOUT_MS / 1000}s — redaction unverified`;
    const surfaces = [
      ['document', `${base}/documents/canary`],
      ['chunks', `${base}/documents/canary/chunks`],
      ['memories', `${base}/memories/list?limit=100`],
    ];
    for (const [name, path] of surfaces) {
      const r = await withRetry(() => hindsightRequest(hs, 'GET', path));
      if (!r.ok) return `canary ${name} unreadable (HTTP ${r.status}) — redaction unverified`;
      if (r.text.includes(CANARY_SECRET)) return `canary secret LEAKED into stored ${name} — server redaction is not active`;
    }
    return null;
  } catch (err) {
    return `canary failed: ${err.message}`;
  } finally {
    try {
      const del = await hindsightRequest(hs, 'DELETE', base);
      if (!del.ok && del.status !== 404) console.error(`  ! could not delete canary bank ${bank} (HTTP ${del.status})`);
    } catch (err) {
      console.error(`  ! could not delete canary bank ${bank}: ${err.message}`);
    }
  }
}

async function existingDocument(hs, doc) {
  const r = await withRetry(() => hindsightRequest(hs, 'GET', `${bankPath(doc.bank)}/documents/${encodeURIComponent(doc.document_id)}`));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET document ${doc.document_id}: HTTP ${r.status}`);
  return r.json;
}

// ---- main -----------------------------------------------------------------------------------
async function main() {
  const hs = DRY ? null : loadHindsight(ROOT);
  if (!DRY && !hs) fail('Hindsight is not enabled: set "enabled": true in global/hindsight.json and HINDSIGHT_API_URL + HINDSIGHT_API_KEY (environment or secrets.env); use --dry-run to estimate');
  settings = hs?.settings ?? loadSettings(ROOT);
  if (!settings) fail('global/hindsight.json is missing');

  const stats = { empty: 0, unattributed: 0, excluded: 0 };
  const collected = [];
  if (SOURCES.includes('memory')) collected.push(...samebrainMemory());
  if (SOURCES.includes('claude-memory')) collected.push(...claudeAutoMemory());
  if (SOURCES.includes('codex-memory')) collected.push(...codexMemory());
  if (SOURCES.includes('claude-sessions')) collected.push(...claudeSessions(stats));
  if (SOURCES.includes('codex-sessions')) collected.push(...codexSessions(stats));

  let ledger = {};
  try { ledger = JSON.parse(readFileSync(LEDGER, 'utf8')); } catch { /* first run */ }

  const docs = collected
    .filter((d) => d.content.trim())
    .filter((d) => !ONLY_BANK || d.bank === ONLY_BANK)
    .map((d) => {
      const content_hash = hash(d.content);
      return { ...d, metadata: { ...d.metadata, content_hash, backfill: 'samebrain' }, content_hash, cost: estimate(d.content.length) };
    });
  const known = (d) => !RESEND && ledger[`${d.bank}\n${d.document_id}`] === d.content_hash;
  const unchanged = docs.filter(known);
  const byTime = (a, b) => String(a.timestamp).localeCompare(String(b.timestamp));
  // Budget: curated files are always kept; sessions fill what remains, newest first.
  const curated = docs.filter((d) => d.curated && !known(d)).sort(byTime);
  let room = MAX_USD - curated.reduce((a, d) => a + d.cost.usd, 0);
  const sessions = [];
  const dropped = [];
  for (const d of docs.filter((x) => !x.curated && !known(x)).sort(byTime).reverse()) {
    if (d.cost.usd <= room) { sessions.push(d); room -= d.cost.usd; } else dropped.push(d);
  }
  // Oldest → newest, curated memory files last.
  const pending = [...sessions.sort(byTime), ...curated].slice(0, LIMIT);

  const sum = (list, f) => list.reduce((a, d) => a + f(d), 0);
  const usd = (n) => `$${n.toFixed(2)}`;
  const bySource = new Map();
  for (const d of pending) {
    const s = bySource.get(d.source) ?? { docs: 0, chars: 0, usd: 0, banks: new Set() };
    s.docs += 1; s.chars += d.content.length; s.usd += d.cost.usd; s.banks.add(d.bank);
    bySource.set(d.source, s);
  }
  const byBank = new Map();
  for (const d of pending) byBank.set(d.bank, (byBank.get(d.bank) ?? 0) + d.cost.usd);

  const totalUsd = sum(pending, (d) => d.cost.usd);
  const contentTokens = sum(pending, (d) => d.cost.contentTokens);
  const inTok = sum(pending, (d) => d.cost.input);
  const outTok = sum(pending, (d) => d.cost.output);
  const contentOnlyUsd = (contentTokens * PRICING.inPerM + contentTokens * PRICING.outputRatio * PRICING.outPerM) / 1e6;

  console.log(`hindsight-backfill${DRY ? ' --dry-run' : ''}: sessions since ${new Date(cutoff).toISOString().slice(0, 10)}, cap ${usd(MAX_USD)}`);
  for (const [source, s] of bySource) {
    console.log(`  ${source.padEnd(20)} ${String(s.docs).padStart(5)} docs  ${(s.chars / 1e6).toFixed(2).padStart(7)}M chars  ${String(s.banks.size).padStart(3)} bank(s)  ${usd(s.usd)}`);
  }
  console.log(`  unchanged (ledger) ${unchanged.length}; skipped sessions: ${stats.empty} empty, ${stats.unattributed} unattributable (directory gone, not inside a repo), ${stats.excluded} excluded`);
  console.log(`  banks: ${[...byBank].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([b, c]) => `${b} ${usd(c)}`).join(', ')}${byBank.size > 12 ? `, … (${byBank.size} total)` : ''}`);
  console.log(`  tokens: ${(contentTokens / 1e6).toFixed(2)}M content → ${(inTok / 1e6).toFixed(2)}M in / ${(outTok / 1e6).toFixed(2)}M out with extraction prompt + consolidation`);
  console.log(`  estimate: ${usd(totalUsd)} (content-only floor ${usd(contentOnlyUsd)}) at $${PRICING.inPerM}/1M in, $${PRICING.outPerM}/1M out, ${PRICING.outputRatio * 100}% output`);
  if (pending.length) {
    const firstCurated = pending.findIndex((d) => d.curated);
    console.log(`  order: ${pending.length} items, ${pending[0].timestamp.slice(0, 16)} → ${pending.at(-1).timestamp.slice(0, 16)}; curated files from item ${firstCurated === -1 ? '-' : firstCurated + 1}`);
  }
  if (dropped.length) console.log(`  over cap: ${dropped.length} oldest session(s) left out (${usd(sum(dropped, (d) => d.cost.usd))})`);
  if (VERBOSE) for (const d of pending) console.log(`    ${d.timestamp}  ${d.bank}  ${d.document_id}  ${d.content.length} chars  ${usd(d.cost.usd)}`);

  if (DRY) return;

  const order = pending;
  const saveLedger = () => {
    mkdirSync(dirname(LEDGER), { recursive: true });
    writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  };
  if (order.length) {
    const leak = await redactionCanary(hs);
    if (leak) fail(`aborting before sending anything: ${leak}`);
    console.log('  redaction canary: server stored no trace of the fake key');
  }
  let spent = 0;
  let sent = 0;
  let skipped = 0;
  try {
    for (const doc of order) {
      if (spent + doc.cost.usd > MAX_USD) {
        console.log(`  cap reached: stopping before ${doc.document_id} (${usd(spent)} estimated so far)`);
        break;
      }
      const key = `${doc.bank}\n${doc.document_id}`;
      const existing = await existingDocument(hs, doc);
      const meta = existing?.document_metadata ?? {};
      if (existing && meta.backfill !== 'samebrain') { skipped += 1; continue; } // live hooks own it
      if (existing && !RESEND && meta.content_hash === doc.content_hash) { ledger[key] = doc.content_hash; skipped += 1; continue; }
      const item = {
        content: doc.content,
        document_id: doc.document_id,
        context: doc.context,
        timestamp: doc.timestamp,
        tags: doc.tags,
        metadata: doc.metadata,
        update_mode: doc.update_mode,
        // One consolidation scope per bank: provenance tags stay on facts, not on belief boundaries.
        observation_scopes: 'shared',
        ...(doc.strategy ? { strategy: doc.strategy } : {}),
      };
      // The same bytes always carry the same operation id, so a retry after a lost ack collapses
      // into the original operation instead of paying for extraction twice.
      const operation_id = uuidFrom(`${doc.bank}\n${JSON.stringify(item)}`);
      const r = await withRetry(() => hindsightRequest(hs, 'POST', `${bankPath(doc.bank)}/memories`, { items: [item], async: true, operation_id }, 60000));
      if (!r.ok) {
        console.error(`  ! ${doc.bank} ${doc.document_id}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
        continue;
      }
      ledger[key] = doc.content_hash;
      spent += doc.cost.usd;
      sent += 1;
      if (sent % 25 === 0) { saveLedger(); console.log(`  … ${sent} sent (${usd(spent)})`); }
    }
  } finally {
    saveLedger(); // an aborted run keeps credit for everything already accepted
  }
  console.log(`  done: ${sent} sent, ${skipped} already present, ${usd(spent)} estimated extraction cost queued`);
}

await main();
