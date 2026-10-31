#!/usr/bin/env node
// Record a durable fact in Hindsight (optional backend; see global/hindsight.json).
//   node bin/memory-retain.mjs --title "<title>" [--date YYYY-MM-DD] [--global | --bank <id>] [--cwd <dir>] "<content>"
//   echo "<content>" | node bin/memory-retain.mjs --title "<title>" -
// Same document shape as the coding-agents `hindsight_ingest_document` tool: the document id is
// the slugged title, so retaining the same title again replaces it, and a title of
// "Correction: <topic>" supersedes a stale memory. --date is when the fact became true (default
// now). Repository bank by default (from --cwd or the working directory); --global for
// cross-project facts. Exit 0 = queued, 1 = rejected, 2 = usage, 3 = Hindsight unconfigured.
// A retain refused for a transient reason (unreachable, 5xx, or the daily spend cap's 429) is
// queued in a local spool and still exits 0; `memory-retain.mjs --flush` (run by the session-end
// sync) resends it, and the stable operation id makes a resend free.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankForCwd, bankPath, hindsightRequest, loadHindsight, scrub } from '../hooks/hindsight.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const VALUED = new Set(['--title', '--date', '--bank', '--cwd', '--agent']);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));
const usage = (msg) => {
  console.error(`memory-retain: ${msg}\nusage: memory-retain.mjs --title "<title>" [--date YYYY-MM-DD] [--global | --bank <id>] "<content>"`);
  process.exit(2);
};

const SPOOL = join(homedir(), '.hindsight', 'samebrain-retain-spool.jsonl');
const transient = (r) => !r || r.status >= 500 || r.status === 429;
const send = (hs, bank, item, operation_id) =>
  hindsightRequest(hs, 'POST', `${bankPath(bank)}/memories`, { items: [item], async: true, operation_id }, 30000).catch(() => null);

if (args.includes('--flush')) {
  const hs = loadHindsight(root);
  if (!hs || !existsSync(SPOOL)) process.exit(0);
  // Claim the spool atomically so a retain spooled meanwhile lands in a fresh file, not lost on rewrite.
  const claimed = `${SPOOL}.${process.pid}`;
  renameSync(SPOOL, claimed);
  const lines = readFileSync(claimed, 'utf8').split('\n').filter(Boolean);
  const left = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { console.error('memory-retain: dropped an unreadable spool line'); continue; }
    if (left.length) { left.push(line); continue; }
    const r = await send(hs, entry.bank, entry.item, entry.operation_id);
    if (transient(r)) left.push(line);
    else if (!r.ok) console.error(`memory-retain: dropped spooled "${entry.item?.metadata?.title}" (HTTP ${r.status}) ${r.text.slice(0, 300)}`);
  }
  if (left.length) appendFileSync(SPOOL, `${left.join('\n')}\n`, { mode: 0o600 });
  rmSync(claimed);
  console.log(`memory-retain: resent ${lines.length - left.length} of ${lines.length} spooled retain(s)`);
  process.exit(0);
}

const title = flag('--title')?.trim();
if (!title) usage('--title is required');
const raw = positional.join(' ') === '-' ? readFileSync(0, 'utf8') : positional.join(' ');
if (!raw.trim()) usage('content is required');
const date = flag('--date');
const timestamp = date ? new Date(date) : new Date();
if (Number.isNaN(timestamp.getTime())) usage(`--date "${date}" is not a date`);

const hs = loadHindsight(root);
if (!hs) {
  console.error('memory-retain: Hindsight is not enabled (set "enabled": true in global/hindsight.json and HINDSIGHT_API_URL + HINDSIGHT_API_KEY)');
  process.exit(3);
}

const bank = flag('--bank') ?? (args.includes('--global') ? hs.settings.globalBank : bankForCwd(flag('--cwd') ?? process.cwd(), hs.settings));
const agent = flag('--agent') ?? process.env.SAMEBRAIN_AGENT;
const documentId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
const item = {
  content: scrub(`# ${title}\n\n${raw.trim()}`),
  document_id: documentId,
  context: 'ingested document',
  timestamp: timestamp.toISOString(),
  tags: ['source:upload', ...(agent ? [`harness:${agent}`] : [])],
  metadata: { source: 'memory-retain', title, ...(agent ? { harness: agent } : {}) },
  strategy: 'document',
  update_mode: 'replace',
  observation_scopes: 'shared',
};
// The same bytes always carry the same operation id, so a retry cannot pay for extraction twice.
const h = createHash('sha256').update(`${bank}\n${JSON.stringify(item)}`).digest('hex').slice(0, 32).split('');
h[12] = '5';
h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
const x = h.join('');
const operation_id = `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;

const r = await send(hs, bank, item, operation_id);
if (transient(r)) {
  mkdirSync(dirname(SPOOL), { recursive: true });
  appendFileSync(SPOOL, `${JSON.stringify({ bank, item, operation_id })}\n`, { mode: 0o600 });
  console.log(`memory-retain: Hindsight ${r ? `refused it for now (HTTP ${r.status})` : 'unreachable'}; "${title}" is queued locally and resent at the next session end`);
  process.exit(0);
}
if (!r.ok) {
  console.error(`memory-retain: rejected (HTTP ${r.status}) ${r.text.slice(0, 300)}`);
  process.exit(1);
}
console.log(`retained "${title}" → bank ${bank}, document ${documentId}, dated ${item.timestamp.slice(0, 10)} (operation ${r.json?.operation_id ?? operation_id})`);
