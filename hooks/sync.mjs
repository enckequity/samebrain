#!/usr/bin/env node
// Session-end memory sync: commit + push any memory changes. Fail-silent, never blocks.
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (args, timeout = 10000) =>
  execFileSync('git', args, { cwd: root, timeout, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();

try {
  if (git(['status', '--porcelain', '--', 'memory'])) {
    git(['add', 'memory']);
    git(['commit', '-m', 'mem: session update', '--quiet']);
  }
  // Push any unpushed commits (this session's or a previously offline one)
  git(['push', '--quiet'], 15000);
} catch { /* offline — next session's recall pull will rebase */ }
