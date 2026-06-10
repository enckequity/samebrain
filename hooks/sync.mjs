#!/usr/bin/env node
// Session-end sync: append one telemetry record, then commit + push memory/telemetry
// changes. Fail-silent, never blocks.
//   sync.mjs --agent <claude|codex|cursor>   (agent name baked in by render.mjs)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agentIdx = process.argv.indexOf('--agent');
const agent = agentIdx !== -1 ? process.argv[agentIdx + 1] : 'unknown';

// Hook payload arrives on stdin (shape varies per agent). Best-effort parse.
let payload = {};
if (!process.stdin.isTTY) {
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/odd payload */ }
}

// One JSONL record per session: only fields the agent gave us for free.
try {
  const now = new Date();
  const machine = hostname().split('.')[0];
  const dir = join(root, 'telemetry', machine);
  mkdirSync(dir, { recursive: true });
  const cwd = payload.cwd ?? payload.workspace_root ?? null;
  const record = {
    ts: now.toISOString(),
    agent,
    machine,
    session_id: payload.session_id ?? payload.conversation_id ?? null,
    cwd_hash: cwd ? createHash('sha256').update(cwd).digest('hex').slice(0, 12) : null,
    duration_s: payload.duration_s ?? null,
  };
  appendFileSync(join(dir, `${now.toISOString().slice(0, 7)}.jsonl`), `${JSON.stringify(record)}\n`);
} catch { /* telemetry is best-effort */ }

const git = (args, timeout = 10000) =>
  execFileSync('git', args, { cwd: root, timeout, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();

try {
  if (git(['status', '--porcelain', '--', 'memory', 'telemetry'])) {
    git(['add', 'memory', 'telemetry']);
    git(['commit', '-m', 'mem: session update', '--quiet']);
  }
  // Push any unpushed commits (this session's or a previously offline one)
  git(['push', '--quiet'], 15000);
} catch { /* offline — next session's recall pull will rebase */ }
