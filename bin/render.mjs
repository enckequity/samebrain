#!/usr/bin/env node
// Render canonical agent config to per-agent global files on THIS machine. Idempotent.
//   node bin/render.mjs            apply
//   node bin/render.mjs --check    report drift, write nothing
//
// Owns (full render, backup once):  ~/.codex/AGENTS.md, ~/.claude/CLAUDE.md, ~/.cursor/mcp.json,
//                                   ~/.claude/skills/*
// Merges (non-destructive):         ~/.claude.json mcpServers, ~/.claude/settings.json hooks,
//                                   ~/.codex/hooks.json, ~/.cursor/hooks.json
//
// Secrets: string values in global/mcp.json may use ${ENV_VAR} (resolved from the environment)
// or op://vault/item/field (resolved via the 1Password CLI). Never commit raw secrets.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = homedir();
const CHECK = process.argv.includes('--check');
const read = (p) => readFileSync(p, 'utf8');
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s); // tolerate editor BOMs
const readJson = (p) => JSON.parse(stripBom(read(p)));
const fail = (msg) => { console.error(`render: ${msg}`); process.exit(1); };
const changes = [];

// Repo path as agents should see it (used for the {{REPO}} token in markdown).
const REPO_DISPLAY = ROOT.startsWith(HOME)
  ? `~${ROOT.slice(HOME.length).replaceAll('\\', '/')}`
  : ROOT.replaceAll('\\', '/');

function backupOnce(target) {
  if (!existsSync(target)) return;
  const dest = join(ROOT, 'backups', `${process.platform}-${target.replaceAll(/[\\/:]/g, '_')}`);
  if (!existsSync(dest)) { mkdirSync(join(ROOT, 'backups'), { recursive: true }); copyFileSync(target, dest); }
}

function writeIfChanged(target, content, label) {
  const current = existsSync(target) ? read(target) : null;
  if (current === content) return;
  changes.push(label);
  if (CHECK) return;
  backupOnce(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const MARKER = '<!-- rendered by samebrain (bin/render.mjs) — edit global/*.md there, not here -->';
const md = (p) => stripBom(read(p)).trim().replaceAll('{{REPO}}', REPO_DISPLAY);
const guardrails = md(join(ROOT, 'global', 'guardrails.md'));
const coordination = md(join(ROOT, 'global', 'coordination.md'));
const addendum = (name) => {
  const p = join(ROOT, 'global', 'addenda', `${name}.md`);
  return existsSync(p) ? `\n\n${md(p)}` : '';
};

// ---- 1. Codex global instructions -------------------------------------------------
writeIfChanged(
  join(HOME, '.codex', 'AGENTS.md'),
  `${MARKER}\n\n${guardrails}\n\n${coordination}${addendum('codex')}\n`,
  'codex: ~/.codex/AGENTS.md',
);

// ---- 2. Claude global instructions ------------------------------------------------
const rtk = existsSync(join(HOME, '.claude', 'RTK.md')) ? '\n\n@RTK.md' : '';
writeIfChanged(
  join(HOME, '.claude', 'CLAUDE.md'),
  `${MARKER}\n\n${guardrails}\n\n${coordination}${addendum('claude')}${rtk}\n`,
  'claude: ~/.claude/CLAUDE.md',
);

// ---- 2b. Gemini CLI / Copilot CLI — rendered only where the agent is installed ------
// No session hooks wired for these yet, so their instructions carry a memory-bootstrap
// line telling the agent to read the shared index itself each session.
// (opencode needs no target: it reads ~/.claude/CLAUDE.md globally by default.)
const MEMORY_BOOTSTRAP = `\n\n## Memory bootstrap\n\nAt the start of each session, read \`${REPO_DISPLAY}/memory/MEMORY.md\` — durable cross-agent facts (details in memory/topics/).`;
if (existsSync(join(HOME, '.gemini'))) {
  writeIfChanged(
    join(HOME, '.gemini', 'GEMINI.md'),
    `${MARKER}\n\n${guardrails}\n\n${coordination}${addendum('gemini')}${MEMORY_BOOTSTRAP}\n`,
    'gemini: ~/.gemini/GEMINI.md',
  );
}
if (existsSync(join(HOME, '.copilot'))) {
  writeIfChanged(
    join(HOME, '.copilot', 'instructions', 'samebrain.instructions.md'),
    `---\napplyTo: "**"\n---\n\n${MARKER}\n\n${guardrails}\n\n${coordination}${addendum('copilot')}${MEMORY_BOOTSTRAP}\n`,
    'copilot: ~/.copilot/instructions/samebrain.instructions.md',
  );
}

// ---- 3. MCP ------------------------------------------------------------------------
// Optional machine-local secrets file (gitignored): KEY=VALUE lines feed ${VAR} refs.
// Process env wins over the file so one-off overrides stay possible.
const localSecrets = {};
{
  const secretsFile = join(ROOT, 'secrets.env');
  if (existsSync(secretsFile)) {
    for (const line of read(secretsFile).split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) localSecrets[m[1]] = m[2];
    }
  }
}

const opCache = new Map();
const opRead = (ref) => {
  if (!opCache.has(ref)) {
    try {
      opCache.set(ref, execFileSync('op', ['read', ref], { timeout: 30000 }).toString().trim());
    } catch {
      fail(`op read ${ref} failed — is the 1Password CLI installed and signed in?`);
    }
  }
  return opCache.get(ref);
};
function resolveSecrets(value, server) {
  if (typeof value === 'string') {
    const expanded = value.replaceAll(/\$\{([A-Za-z0-9_]+)\}/g, (_, name) => {
      const v = process.env[name] ?? localSecrets[name];
      if (v === undefined) {
        fail(`mcp server "${server}": \${${name}} is not set (environment or secrets.env)`);
      }
      return v;
    });
    return expanded.startsWith('op://') ? opRead(expanded) : expanded;
  }
  if (Array.isArray(value)) return value.map((v) => resolveSecrets(v, server));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveSecrets(v, server)]));
  }
  return value;
}

const canonical = readJson(join(ROOT, 'global', 'mcp.json')).mcpServers ?? {};
const serverFor = (name, def) => {
  const { targets, os, win, rendered_name, _comment, ...base } = def;
  const eff = process.platform === 'win32' && win ? { ...base, ...win } : base;
  return resolveSecrets(eff, name);
};
const wanted = (agent) => Object.fromEntries(
  Object.entries(canonical)
    .filter(([, d]) => d.targets.includes(agent) && (!d.os || d.os.includes(process.platform)))
    .map(([name, d]) => [d.rendered_name ?? name, serverFor(name, d)]),
);

// 3a. Cursor: full ownership of ~/.cursor/mcp.json
writeIfChanged(
  join(HOME, '.cursor', 'mcp.json'),
  `${JSON.stringify({ mcpServers: wanted('cursor') }, null, 2)}\n`,
  'cursor: ~/.cursor/mcp.json',
);

// 3b. Claude: merge-by-key into live ~/.claude.json (never delete unmanaged keys)
{
  const target = join(HOME, '.claude.json');
  const live = existsSync(target) ? readJson(target) : {};
  const merged = { ...(live.mcpServers ?? {}) };
  let dirty = false;
  for (const [name, def] of Object.entries(wanted('claude'))) {
    if (JSON.stringify(merged[name]) !== JSON.stringify(def)) { merged[name] = def; dirty = true; }
  }
  if (dirty) {
    changes.push('claude: ~/.claude.json mcpServers (merge)');
    if (!CHECK) {
      backupOnce(target);
      writeFileSync(target, JSON.stringify({ ...live, mcpServers: merged }, null, 2));
    }
  }
}

// ---- 4. Memory hooks ----------------------------------------------------------------
const node = process.execPath; // absolute node path — hooks run outside any shell profile
const recall = join(ROOT, 'hooks', 'recall.mjs');
const sync = join(ROOT, 'hooks', 'sync.mjs');
const cmd = (script, flag = '') => `"${node}" "${script}"${flag ? ` ${flag}` : ''}`;

function mergeJsonFile(target, label, mutate) {
  const live = existsSync(target) ? readJson(target) : {};
  const next = JSON.parse(JSON.stringify(live));
  mutate(next);
  if (JSON.stringify(live) === JSON.stringify(next)) return;
  changes.push(label);
  if (CHECK) return;
  backupOnce(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
}

// 4a. Claude Code (~/.claude/settings.json) — append-if-absent, preserve existing hooks
mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json memory hooks', (s) => {
  s.hooks ??= {};
  const ensure = (event, command) => {
    s.hooks[event] ??= [];
    const all = s.hooks[event].flatMap((e) => e.hooks ?? []);
    if (!all.some((h) => h.command === command)) {
      s.hooks[event].push({ matcher: '', hooks: [{ type: 'command', command }] });
    }
  };
  ensure('SessionStart', cmd(recall));
  ensure('SessionEnd', cmd(sync));
});

// 4b. Codex (~/.codex/hooks.json)
mergeJsonFile(join(HOME, '.codex', 'hooks.json'), 'codex: hooks.json memory hooks', (s) => {
  s.hooks ??= {};
  const ensure = (event, command) => {
    s.hooks[event] ??= [];
    const all = s.hooks[event].flatMap((e) => e.hooks ?? []);
    if (!all.some((h) => h.command === command)) {
      s.hooks[event].push({ hooks: [{ type: 'command', command }] });
    }
  };
  ensure('SessionStart', cmd(recall));
  ensure('Stop', cmd(sync));
});

// 4c. Cursor (~/.cursor/hooks.json) — flat {command} entries
mergeJsonFile(join(HOME, '.cursor', 'hooks.json'), 'cursor: hooks.json memory hooks', (s) => {
  s.version ??= 1;
  s.hooks ??= {};
  const ensure = (event, command) => {
    s.hooks[event] ??= [];
    if (!s.hooks[event].some((h) => h.command === command)) s.hooks[event].push({ command });
  };
  ensure('sessionStart', cmd(recall, '--cursor'));
  ensure('stop', cmd(sync));
});

// ---- 5. Skills + liveness hooks (Claude Code only) -----------------------------------
{
  const skillsDir = join(ROOT, 'skills');
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const src = join(skillsDir, name, 'SKILL.md');
      if (!existsSync(src)) continue;
      writeIfChanged(
        join(HOME, '.claude', 'skills', name, 'SKILL.md'),
        `${md(src)}\n\n<!-- rendered by samebrain (bin/render.mjs) — edit skills/${name}/SKILL.md in the repo, not here -->\n`,
        `claude: ~/.claude/skills/${name}/SKILL.md`,
      );
    }
  }
}
mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json smartloop hooks', (s) => {
  s.hooks ??= {};
  const ensure = (event, command) => {
    s.hooks[event] ??= [];
    const all = s.hooks[event].flatMap((e) => e.hooks ?? []);
    if (!all.some((h) => h.command === command)) {
      s.hooks[event].push({ matcher: '', hooks: [{ type: 'command', command }] });
    }
  };
  ensure('SessionStart', cmd(join(ROOT, 'hooks', 'smartloop-sweep.mjs')));
  ensure('Stop', cmd(join(ROOT, 'hooks', 'smartloop-stop.mjs')));
});

// ---- report -------------------------------------------------------------------------
if (changes.length === 0) {
  console.log('render: everything in sync');
} else {
  console.log(`render${CHECK ? ' --check (no writes)' : ''}:`);
  for (const c of changes) console.log(`  ${CHECK ? 'drift' : 'wrote'}: ${c}`);
}
