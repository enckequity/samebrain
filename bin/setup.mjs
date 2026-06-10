#!/usr/bin/env node
// One-command setup. Renders config to every agent and turns on auto-render after git pulls.
//   node bin/setup.mjs
//   node bin/setup.mjs --opensync   also print install steps for OpenSync session-sync plugins
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

console.log('samebrain setup\n');

// Optional adapter: hosted dashboards via OpenSync (opensync.dev). samebrain never depends
// on it — the local alternative is node bin/dashboard.mjs. Printed, not auto-installed:
// setup must stay offline-safe and never modify global npm state unasked.
if (process.argv.includes('--opensync')) {
  console.log(`OpenSync session-sync plugins (hosted dashboards — local alternative: node bin/dashboard.mjs):
  npm install -g claude-code-sync      && claude-code-sync login
  npm install -g codex-sync            && codex-sync login
  npm install -g cursor-sync-plugin    && cursor-sync login
Docs: https://opensync.dev
`);
}

// 1. Render config to every agent on this machine.
const render = spawnSync(process.execPath, [join(ROOT, 'bin', 'render.mjs')], {
  cwd: ROOT, stdio: 'inherit',
});
if (render.status !== 0) {
  console.error('\nSetup stopped: the render step failed (see message above). Fix it and re-run.');
  process.exit(render.status ?? 1);
}

// 2. Auto-render whenever you `git pull` (best-effort: skipped outside a git clone).
let hookEnabled = false;
try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, stdio: 'ignore' });
  hookEnabled = true;
} catch { /* not a git clone, or git missing — render still worked */ }

console.log(`
Done! Every AI coding agent on this machine now shares the same rules, tools, and memory.
${hookEnabled ? 'Auto-render is on: pulling this repo re-applies config automatically.' : 'Note: could not enable auto-render (not a git clone?) — re-run node bin/render.mjs after pulls.'}

Make it yours:
  global/guardrails.md   your rules for every agent, in plain English
  global/mcp.json        your MCP servers (tools agents can use)
  memory/MEMORY.md       shared memory — agents maintain this themselves

After editing, apply with:  node bin/render.mjs
On another computer:        clone this repo, run this same setup.
`);
