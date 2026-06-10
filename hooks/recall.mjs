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

let index = '';
try {
  index = readFileSync(join(root, 'memory', 'MEMORY.md'), 'utf8');
} catch { process.exit(0); }

const body =
  `<shared-agent-memory source="${display}/memory" detail-files="memory/topics/*.md">\n${index.trim()}\n</shared-agent-memory>`;

if (process.argv.includes('--cursor')) {
  process.stdout.write(JSON.stringify({ additional_context: body }));
} else {
  process.stdout.write(body);
}
