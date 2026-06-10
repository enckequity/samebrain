#!/usr/bin/env node
// Session-start memory recall: fast git pull (fail-silent), then emit the memory index.
// Plain stdout for Claude Code / Codex (stdout -> context). `--cursor` wraps in
// Cursor's sessionStart JSON contract ({ additional_context }).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = homedir();
const display = root.startsWith(home)
  ? `~${root.slice(home.length).replaceAll('\\', '/')}`
  : root.replaceAll('\\', '/');

try {
  execFileSync('git', ['pull', '--rebase', '--autostash', '--quiet'], {
    cwd: root, timeout: 8000, stdio: ['ignore', 'ignore', 'ignore'],
  });
} catch { /* offline or slow remote — serve the local copy */ }

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

// Token-tax guard: the index is injected into every session of every agent —
// when it outgrows the cap, tell the agent (the one actor who can prune it).
const CAP = 120;
const factLines = index.split('\n').filter((l) => l.trim()).length;
const warn = factLines > CAP
  ? `\n\nWARNING: memory index has ${factLines} non-blank lines (cap ${CAP}). Prune now: merge stale facts into memory/topics/*.md or delete them.`
  : '';

const body =
  `<shared-agent-memory source="${display}/memory" detail-files="memory/topics/*.md">\n${index.trim()}${warn}\n</shared-agent-memory>`;

if (process.argv.includes('--cursor')) {
  process.stdout.write(JSON.stringify({ additional_context: body }));
} else {
  process.stdout.write(body);
}
