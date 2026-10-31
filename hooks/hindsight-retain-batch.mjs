// Batches the coding-agents runtime's per-turn session capture.
//
// The runtime retains on every Stop, and each small append costs a full extraction prompt
// (~4k tokens of overhead) plus a consolidation pass, so a long session was re-read about ten times over.
// This wrapper forwards a Stop to the runtime only when the session's transcript has grown
// enough or enough time has passed since its last retain. The runtime's cursor appends every
// turn since that retain, so a skipped Stop is folded into the next one rather than lost.
// `--flush` (Claude SessionEnd) always forwards pending turns, in the background so the host's
// short session-end budget cannot kill it. Every run, and `--sweep` at Claude session start, also
// flushes other sessions left idle with pending turns (crashed hosts, Codex, no session end).
// A session's state only advances after the runtime exits cleanly, so a failed retain is retried.
//
//   node hindsight-retain-batch.mjs --upstream <runtime>/dist/claude-stop-hook.js [--flush]
//   node hindsight-retain-batch.mjs --sweep
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== '' ? Number(value) : fallback);
export const BATCH_MS = num(process.env.HINDSIGHT_RETAIN_BATCH_MS, 15 * 60_000);
export const BATCH_BYTES = num(process.env.HINDSIGHT_RETAIN_BATCH_BYTES, 512 * 1024);
const IDLE_MS = num(process.env.HINDSIGHT_RETAIN_IDLE_MS, 30 * 60_000);
const UPSTREAM_TIMEOUT_MS = 55_000;
const SWEEP_MAX = 2;
const EXPIRE_MS = 7 * 24 * 3_600_000;
const SELF = fileURLToPath(import.meta.url);

const stateDir = () => join(homedir(), '.hindsight', 'state', 'retain-batch');
const stateFile = (sessionId) => join(stateDir(), `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(file, state) {
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

const sizeOf = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
};

const mtimeOf = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

// Pure decision: forward this event to the runtime now, or defer it to a later retain?
export function shouldRetain({ last, size, now, flush }) {
  if (!last || size === null) return true;
  if (size === last.size) return false;
  // A shrunk transcript was rewritten; the runtime replaces the document rather than appending.
  if (size < last.size || flush) return true;
  return size - last.size >= BATCH_BYTES || now - last.at >= BATCH_MS;
}

// Run the runtime hook and record the retain only when it exited cleanly.
function forwardNow(upstream, event) {
  const run = spawnSync(process.execPath, [upstream], {
    input: JSON.stringify(event), stdio: ['pipe', 'inherit', 'inherit'], timeout: UPSTREAM_TIMEOUT_MS,
  });
  if (run.error || run.status !== 0) {
    console.error(`hindsight-retain-batch: runtime hook failed (${run.error?.message ?? `exit ${run.status}`}); turns stay pending`);
    return;
  }
  if (!event?.session_id) return;
  const now = Date.now();
  writeState(stateFile(event.session_id), { size: sizeOf(event.transcript_path) ?? 0, at: now, seenAt: now, upstream, event });
}

// Hand a retain to a detached copy of this script, which runs forwardNow outside the host budget.
function forwardLater(upstream, event) {
  const child = spawn(process.execPath, [SELF, `--upstream=${upstream}`, '--now'], {
    detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
  });
  child.on('error', (err) => console.error(`hindsight-retain-batch: background retain failed: ${err.message}`));
  child.stdin.end(JSON.stringify(event));
  child.unref();
}

// Flush sessions that stopped with turns still pending and have gone quiet since.
function sweepIdle(currentFile, now) {
  let names = [];
  try {
    names = readdirSync(stateDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  let flushed = 0;
  for (const name of names) {
    const file = join(stateDir(), name);
    if (file === currentFile) continue;
    const state = readState(file);
    const path = state?.event?.transcript_path;
    if (!path || !state.upstream) continue;
    const size = sizeOf(path);
    if (size === null) {
      rmSync(file, { force: true });
      continue;
    }
    if (size === state.size) {
      if (now - state.at > EXPIRE_MS) rmSync(file, { force: true });
      continue;
    }
    if (flushed >= SWEEP_MAX || now - (state.seenAt ?? state.at) < IDLE_MS || now - mtimeOf(path) < IDLE_MS) continue;
    // Claim before forwarding so a concurrent sweep skips this session.
    writeState(file, { ...state, seenAt: now });
    forwardLater(state.upstream, state.event);
    flushed += 1;
  }
}

const upstreamArg = (argv) => {
  const inline = argv.find((a) => a.startsWith('--upstream='));
  if (inline) return inline.slice('--upstream='.length);
  const at = argv.indexOf('--upstream');
  return at >= 0 ? argv[at + 1] : undefined;
};

export function main(argv = process.argv.slice(2), stdin = () => readFileSync(0, 'utf8')) {
  const now = Date.now();
  if (argv.includes('--sweep')) {
    sweepIdle(null, now);
    return 0;
  }
  const upstream = upstreamArg(argv);
  if (!upstream) {
    console.error('hindsight-retain-batch: --upstream <runtime hook> is required');
    return 1;
  }
  let event;
  try {
    event = JSON.parse(stdin());
  } catch {
    return 0;
  }
  if (argv.includes('--now')) {
    forwardNow(upstream, event);
    return 0;
  }
  const sessionId = event?.session_id;
  if (process.env.HINDSIGHT_DISABLE_HOOKS || !sessionId || !event.transcript_path) {
    forwardNow(upstream, event);
    return 0;
  }
  const flush = argv.includes('--flush');
  const file = stateFile(sessionId);
  const last = readState(file);
  if (shouldRetain({ last, size: sizeOf(event.transcript_path), now, flush })) {
    if (flush) forwardLater(upstream, event);
    else forwardNow(upstream, event);
  } else if (last) {
    writeState(file, { ...last, seenAt: now, upstream, event });
  }
  sweepIdle(file, now);
  return 0;
}

// realpath: hooks run from symlinked homes and temp dirs, where argv[1] is not the module path.
if (process.argv[1] && realpathSync(process.argv[1]) === SELF) {
  try {
    process.exitCode = main();
  } catch (err) {
    // Capture is best effort: never fail the host session over it.
    console.error(`hindsight-retain-batch: ${err.message}`);
    process.exitCode = 0;
  }
}
