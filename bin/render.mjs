#!/usr/bin/env node
// Render canonical agent config to per-agent global files on THIS machine. Idempotent.
//   node bin/render.mjs                     apply
//   node bin/render.mjs --check             report drift, write nothing
//   node bin/render.mjs --gc                roll telemetry months older than 3 into archive lines
//   node bin/render.mjs --ack-cursor-rules  record that Cursor User Rules match global/cursor-user-rules.md
//
// Owns (full render, backup once):  ~/.codex/AGENTS.md, ~/.claude/CLAUDE.md, ~/.cursor/mcp.json,
//                                   ~/.claude/skills/*, ~/.cursor/skills/*, ~/.codex/prompts/*
// Merges (non-destructive):         ~/.claude.json mcpServers, ~/.claude/settings.json hooks,
//                                   ~/.codex/hooks.json, ~/.cursor/hooks.json,
//                                   ~/.codex/config.toml mcp_servers (opt-in)
//
// Secrets: string values in global/mcp.json may use ${ENV_VAR} (resolved from the environment)
// or op://vault/item/field (resolved via the 1Password CLI). Never commit raw secrets.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = homedir();
const CHECK = process.argv.includes('--check');
const GC = process.argv.includes('--gc');
const ACK = process.argv.includes('--ack-cursor-rules');
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
// opencode (also reads ~/.claude/CLAUDE.md, but an explicit AGENTS.md survives that
// default changing), Factory Droid, and Pi: global AGENTS.md, detection-gated.
for (const [name, dir] of [
  ['opencode', join(HOME, '.config', 'opencode')],
  ['droid', join(HOME, '.factory')],
  ['pi', join(HOME, '.pi')],
]) {
  if (existsSync(dir)) {
    writeIfChanged(
      join(dir, 'AGENTS.md'),
      `${MARKER}\n\n${guardrails}\n\n${coordination}${addendum(name)}${MEMORY_BOOTSTRAP}\n`,
      `${name}: ${join(dir, 'AGENTS.md')}`,
    );
  }
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

// 3c. Codex: opt-in — servers listing "codex" in targets merge into ~/.codex/config.toml
// [mcp_servers.*]. Section-level merge: only sections samebrain renders are touched.
{
  const servers = wanted('codex');
  if (Object.keys(servers).length > 0) {
    const tomlValue = (v) => {
      if (typeof v === 'string') return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
      if (v && typeof v === 'object') {
        return `{ ${Object.entries(v).map(([k, x]) => `${k} = ${tomlValue(x)}`).join(', ')} }`;
      }
      return JSON.stringify(v);
    };
    const tomlSection = (name, def) => {
      const { type, ...rest } = def; // "type" is a claude/cursor concept; codex infers transport
      const lines = Object.entries(rest)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k} = ${tomlValue(v)}`);
      return `[mcp_servers.${name}]\n${lines.join('\n')}\n`;
    };
    const upsertSection = (content, name, section) => {
      // Replace from the section header to the next top-level header (or EOF).
      const re = new RegExp(`(^|\\n)\\[mcp_servers\\.${name.replaceAll('.', '\\.')}\\][^\\n]*\\n(?:(?!\\[)[^\\n]*\\n?)*`);
      if (re.test(content)) return content.replace(re, (m, lead) => `${lead}${section}`);
      return content === '' ? section : `${content.replace(/\n*$/, '\n\n')}${section}`;
    };
    const target = join(HOME, '.codex', 'config.toml');
    const live = existsSync(target) ? read(target) : '';
    let next = live;
    for (const [name, def] of Object.entries(servers)) next = upsertSection(next, name, tomlSection(name, def));
    if (next !== live) {
      changes.push('codex: ~/.codex/config.toml mcp_servers (merge)');
      if (!CHECK) {
        backupOnce(target);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, next);
      }
    }
  }
}

// ---- 4. Memory hooks ----------------------------------------------------------------
const node = process.execPath; // absolute node path — hooks run outside any shell profile
const recall = join(ROOT, 'hooks', 'recall.mjs');
const sync = join(ROOT, 'hooks', 'sync.mjs');
const cmd = (script, flag = '') => `"${node}" "${script}"${flag ? ` ${flag}` : ''}`;
// A hook command is "ours" if it runs a script of the same filename — lets a render
// upgrade a managed command in place (e.g. adding flags) without duplicating it.
const managesScript = (command, script) => new RegExp(`[\\\\/]${basename(script).replaceAll('.', '\\.')}"`).test(command);

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

// Nested {hooks:[{command}]} ensure (Claude/Codex shape): prune stale managed variants
// of the same script, then add if absent.
const ensureNested = (s, event, command, script, mkEntry) => {
  s.hooks[event] ??= [];
  for (const entry of s.hooks[event]) {
    if (entry.hooks) entry.hooks = entry.hooks.filter((h) => h.command === command || !managesScript(h.command, script));
  }
  s.hooks[event] = s.hooks[event].filter((e) => !e.hooks || e.hooks.length > 0);
  const all = s.hooks[event].flatMap((e) => e.hooks ?? []);
  if (!all.some((h) => h.command === command)) s.hooks[event].push(mkEntry(command));
};

// 4a. Claude Code (~/.claude/settings.json) — append-if-absent, preserve existing hooks
mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json memory hooks', (s) => {
  s.hooks ??= {};
  const entry = (command) => ({ matcher: '', hooks: [{ type: 'command', command }] });
  ensureNested(s, 'SessionStart', cmd(recall), recall, entry);
  ensureNested(s, 'SessionEnd', cmd(sync, '--agent claude'), sync, entry);
});

// 4b. Codex (~/.codex/hooks.json)
mergeJsonFile(join(HOME, '.codex', 'hooks.json'), 'codex: hooks.json memory hooks', (s) => {
  s.hooks ??= {};
  const entry = (command) => ({ hooks: [{ type: 'command', command }] });
  ensureNested(s, 'SessionStart', cmd(recall), recall, entry);
  ensureNested(s, 'Stop', cmd(sync, '--agent codex'), sync, entry);
});

// 4c. Cursor (~/.cursor/hooks.json) — flat {command} entries
mergeJsonFile(join(HOME, '.cursor', 'hooks.json'), 'cursor: hooks.json memory hooks', (s) => {
  s.version ??= 1;
  s.hooks ??= {};
  const ensure = (event, command, script) => {
    s.hooks[event] ??= [];
    s.hooks[event] = s.hooks[event].filter((h) => h.command === command || !managesScript(h.command, script));
    if (!s.hooks[event].some((h) => h.command === command)) s.hooks[event].push({ command });
  };
  ensure('sessionStart', cmd(recall, '--cursor'), recall);
  ensure('stop', cmd(sync, '--agent cursor'), sync);
});

// ---- 5. Skills (all agents) + liveness hooks ------------------------------------------
// Optional `targets:` line in a skill's frontmatter limits which agents receive it
// (e.g. `targets: claude`). Default: claude, cursor, codex.
{
  const skillsDir = join(ROOT, 'skills');
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const src = join(skillsDir, name, 'SKILL.md');
      if (!existsSync(src)) continue;
      const body = md(src);
      const fm = body.match(/^---\n([\s\S]*?)\n---/);
      const targetsLine = fm?.[1].match(/^targets:\s*(.+)$/m)?.[1];
      const targets = targetsLine ? targetsLine.split(/[,\s]+/).filter(Boolean) : ['claude', 'cursor', 'codex'];
      const out = `${body}\n\n<!-- rendered by samebrain (bin/render.mjs) — edit skills/${name}/SKILL.md in the repo, not here -->\n`;
      if (targets.includes('claude')) {
        writeIfChanged(join(HOME, '.claude', 'skills', name, 'SKILL.md'), out, `claude: ~/.claude/skills/${name}/SKILL.md`);
      }
      if (targets.includes('cursor')) {
        writeIfChanged(join(HOME, '.cursor', 'skills', name, 'SKILL.md'), out, `cursor: ~/.cursor/skills/${name}/SKILL.md`);
      }
      if (targets.includes('codex')) {
        writeIfChanged(join(HOME, '.codex', 'prompts', `${name}.md`), out, `codex: ~/.codex/prompts/${name}.md`);
      }
    }
  }
}
// smartloop liveness hooks — all three agents (the state-file protocol is agent-neutral).
const sweep = join(ROOT, 'hooks', 'smartloop-sweep.mjs');
const slStop = join(ROOT, 'hooks', 'smartloop-stop.mjs');
mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json smartloop hooks', (s) => {
  s.hooks ??= {};
  const entry = (command) => ({ matcher: '', hooks: [{ type: 'command', command }] });
  ensureNested(s, 'SessionStart', cmd(sweep), sweep, entry);
  ensureNested(s, 'Stop', cmd(slStop), slStop, entry);
});
mergeJsonFile(join(HOME, '.codex', 'hooks.json'), 'codex: hooks.json smartloop hooks', (s) => {
  s.hooks ??= {};
  const entry = (command) => ({ hooks: [{ type: 'command', command }] });
  ensureNested(s, 'SessionStart', cmd(sweep), sweep, entry);
  ensureNested(s, 'Stop', cmd(slStop), slStop, entry);
});
mergeJsonFile(join(HOME, '.cursor', 'hooks.json'), 'cursor: hooks.json smartloop hooks', (s) => {
  s.version ??= 1;
  s.hooks ??= {};
  const ensure = (event, command, script) => {
    s.hooks[event] ??= [];
    s.hooks[event] = s.hooks[event].filter((h) => h.command === command || !managesScript(h.command, script));
    if (!s.hooks[event].some((h) => h.command === command)) s.hooks[event].push({ command });
  };
  ensure('sessionStart', cmd(sweep, '--cursor'), sweep);
  ensure('stop', cmd(slStop), slStop);
});

// ---- 6. Telemetry hygiene -------------------------------------------------------------
// telemetry/<machine>/<YYYY-MM>.jsonl is appended by hooks/sync.mjs. Warn when the
// current month grows past 1MB; --gc rolls months older than 3 into archive.jsonl.
{
  const telemetryRoot = join(ROOT, 'telemetry');
  if (existsSync(telemetryRoot)) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 3);
    const cutoffMonth = cutoff.toISOString().slice(0, 7);
    const thisMonth = new Date().toISOString().slice(0, 7);
    for (const machine of readdirSync(telemetryRoot)) {
      const dir = join(telemetryRoot, machine);
      let files;
      try { files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)); } catch { continue; }
      for (const file of files) {
        const month = file.slice(0, 7);
        const path = join(dir, file);
        if (month === thisMonth && statSync(path).size > 1024 * 1024) {
          console.log(`render: telemetry ${machine}/${file} exceeds 1MB — run: node bin/render.mjs --gc`);
        }
        if (GC && month < cutoffMonth && !CHECK) {
          const byAgent = {};
          let sessions = 0;
          for (const line of read(path).split('\n').filter(Boolean)) {
            try {
              const rec = JSON.parse(line);
              sessions += 1;
              byAgent[rec.agent ?? 'unknown'] = (byAgent[rec.agent ?? 'unknown'] ?? 0) + 1;
            } catch { /* unparseable line — counted nowhere */ }
          }
          const summary = JSON.stringify({ month, machine, sessions, by_agent: byAgent });
          writeFileSync(join(dir, 'archive.jsonl'), `${existsSync(join(dir, 'archive.jsonl')) ? read(join(dir, 'archive.jsonl')) : ''}${summary}\n`);
          rmSync(path);
          changes.push(`telemetry: rolled ${machine}/${file} into archive.jsonl`);
        }
      }
    }
  }
}

// ---- 7. Cursor User Rules drift check ---------------------------------------------------
// Cursor's global User Rules live in its settings DB (no file API). global/cursor-user-rules.md
// is the canonical paste source; nag whenever it changes until the paste is acknowledged.
{
  const src = join(ROOT, 'global', 'cursor-user-rules.md');
  if (existsSync(src)) {
    const hash = createHash('sha256').update(read(src)).digest('hex').slice(0, 16);
    const ackFile = join(ROOT, '.cursor-rules-ack');
    if (ACK) {
      writeFileSync(ackFile, `${hash}\n`);
      console.log('render: Cursor User Rules paste acknowledged');
    } else if (!existsSync(ackFile) || read(ackFile).trim() !== hash) {
      console.log('render: global/cursor-user-rules.md changed — paste it into Cursor Settings > Rules > User Rules, then run: node bin/render.mjs --ack-cursor-rules');
    }
  }
}

// ---- report -------------------------------------------------------------------------
if (changes.length === 0) {
  console.log('render: everything in sync');
} else {
  console.log(`render${CHECK ? ' --check (no writes)' : ''}:`);
  for (const c of changes) console.log(`  ${CHECK ? 'drift' : 'wrote'}: ${c}`);
}

// Record which engine revision this render applied — the session-start recall hook
// re-renders when HEAD moves past this marker (rebase pulls never fire post-merge).
if (!CHECK) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    mkdirSync(join(ROOT, 'backups'), { recursive: true });
    writeFileSync(join(ROOT, 'backups', '.last-render-head'), `${head}\n`);
  } catch { /* not a git clone — marker simply doesn't exist */ }
}
