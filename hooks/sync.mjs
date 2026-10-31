#!/usr/bin/env node
// Session-end sync: append one telemetry record, then commit + push memory/telemetry/lease
// changes. Fail-silent, never blocks.
//   sync.mjs --agent <claude|codex|cursor>   (agent name baked in by render.mjs)
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {syncGit,syncWarning} from './git-sync.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agentIdx = process.argv.indexOf('--agent');
const agent = agentIdx !== -1 ? process.argv[agentIdx + 1] : 'unknown';

// Hook payload arrives on stdin (shape varies per agent). Best-effort parse.
let payload = {};
if (!process.stdin.isTTY) {
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/odd payload */ }
}
// Harnesses that cannot pipe a payload (e.g. the opencode plugin spawns us with
// stdin ignored) can pass the same fields as env vars instead.
if (process.env.SAMEBRAIN_SESSION_ID) payload.session_id ??= process.env.SAMEBRAIN_SESSION_ID;
if (process.env.SAMEBRAIN_CWD) payload.cwd ??= process.env.SAMEBRAIN_CWD;

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

// Curated memory keeps flowing into Hindsight: Claude Code writes its auto-memory files on its own,
// so each session end queues an incremental, ledgered backfill of the curated sources (unchanged
// files cost nothing). Throttled to once per 10 minutes, detached so the hook never waits.
try {
  // Loaded lazily: copies of this hook that ship without the Hindsight client still sync git.
  const { loadHindsight } = await import('./hindsight.mjs');
  if (process.env.SAMEBRAIN_HINDSIGHT_SYNC !== '0' && loadHindsight(root)) {
    const stamp = join(homedir(), '.hindsight', 'samebrain-memory-sync.json');
    const due = !existsSync(stamp) || Date.now() - statSync(stamp).mtimeMs > 10 * 60000;
    if (due) {
      mkdirSync(dirname(stamp), { recursive: true });
      writeFileSync(stamp, `${JSON.stringify({ at: new Date().toISOString() })}\n`);
      spawn(process.execPath, [join(root, 'bin', 'hindsight-backfill.mjs'), '--sources', 'memory,claude-memory'], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
      spawn(process.execPath, [join(root, 'bin', 'memory-retain.mjs'), '--flush'], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    }
  }
} catch { /* memory sync is best-effort */ }

// Commit leases alongside memory/telemetry so a claim taken on this machine is visible
// to every other machine (the lease protocol says commit the file — this does it for you).
// The helper distinguishes tracked deletions from paths that never existed.
const paths = ['memory', 'telemetry', 'coordination/leases'];

const warning=syncWarning(syncGit(root,{timeout:15000,commitPaths:paths,push:true}));
if(warning)process.stderr.write(warning+'\n');
