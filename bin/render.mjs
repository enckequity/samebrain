#!/usr/bin/env node
// Render canonical agent config to per-agent global files on THIS machine. Idempotent.
//   node bin/render.mjs                     apply
//   node bin/render.mjs --check             report drift, write nothing
//   node bin/render.mjs --gc                roll old telemetry months into archive lines + prune dead leases
//   node bin/render.mjs --ack-cursor-rules  record that Cursor User Rules match global/cursor-user-rules.md
//
// Owns (full render, backup once):  ~/.codex/AGENTS.md, ~/.claude/CLAUDE.md, ~/.cursor/mcp.json,
//                                   ~/.kimi-code/AGENTS.md, ~/.agents/skills/* (Codex/Kimi),
//                                   ~/.claude/skills/*, ~/.cursor/skills/*, ~/.codex/prompts/*,
//                                   ~/.codex/skills/*
//                                   ~/.config/opencode/plugins/* (detection-gated), ~/.config/opencode/agent/*
// Merges (non-destructive):         ~/.claude.json mcpServers, ~/.claude/settings.json hooks,
//                                   ~/.codex/hooks.json, ~/.cursor/hooks.json,
//                                   ~/.codex/config.toml mcp_servers (opt-in),
//                                   ~/.openclaw/workspace/AGENTS.md managed block,
//                                   ~/.openclaw/openclaw.json skills.load.extraDirs
// Hindsight (only when global/hindsight.json is enabled and its URL + key resolve): writes ~/.hindsight/coding-agent.json
//                                   (0600); merges coding-agents hooks into the Claude/Codex/Cursor hook
//                                   files, its MCP server into Claude/Cursor, the runtime into opencode.json,
//                                   and removes the retired hindsight-memory plugin declaration
//
// Secrets: string values in global/mcp.json may use ${ENV_VAR} (resolved from the environment)
// or op://vault/item/field (resolved via the 1Password CLI). Never commit raw secrets.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
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

function copyIfChanged(source, target, label) {
  const content = readFileSync(source);
  const mode = statSync(source).mode & 0o777;
  const sameContent = existsSync(target) && readFileSync(target).equals(content);
  const sameMode = existsSync(target) && (statSync(target).mode & 0o777) === mode;
  if (sameContent && sameMode) return;
  changes.push(label);
  if (CHECK) return;
  backupOnce(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { mode });
  chmodSync(target, mode);
}

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

// Hindsight long-term memory is opt-in: global/hindsight.json describes the wiring, and nothing is
// rendered for it until it sets enabled: true and its URL and key resolve (environment or secrets.env).
const hindsight = (() => {
  const p = join(ROOT, 'global', 'hindsight.json');
  if (!existsSync(p)) return null;
  const settings = readJson(p);
  if (settings.enabled !== true || process.env.SAMEBRAIN_HINDSIGHT === '0') return null;
  const pick = (name) => process.env[name] ?? localSecrets[name];
  const url = pick(settings.apiUrlEnv);
  const key = pick(settings.apiKeyEnv);
  return url && key && /^https?:\/\//.test(url) ? { settings, url: url.replace(/\/+$/, ''), key } : null;
})();

// Node binary written into hook and MCP commands. Never process.execPath: render runs under
// different binaries (a session's node, the git hook's PATH node), and every flip rewrote every
// hook command — which also revoked Codex's per-command hook trust on each pull. Preference:
// SAMEBRAIN_NODE, ~/.local/bin/node, then `command -v node` from a login shell.
const STABLE_NODE = (() => {
  const executable = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  for (const candidate of [process.env.SAMEBRAIN_NODE, join(HOME, '.local', 'bin', 'node')]) {
    if (candidate && executable(candidate)) return candidate;
  }
  if (process.platform !== 'win32') {
    try {
      const found = execFileSync(process.env.SHELL || '/bin/sh', ['-lc', 'command -v node'], {
        timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim().split('\n').pop();
      if (found?.startsWith('/') && executable(found)) return found;
    } catch { /* no login shell or node not on its PATH */ }
  }
  return process.execPath;
})();

// The pinned coding-agents runtime, once bin/hindsight-activate.mjs staged it: hooks and MCP
// servers pointing at a missing file would error every session, so wiring waits for it.
const HINDSIGHT_HOOK_SCRIPTS = [
  'claude-stop-hook.js', 'claude-sessionstart-hook.js', 'claude-hook.js', 'codex-stop-hook.js',
  'cursor-stop-hook.js', 'cursor-sessionstart-hook.js', 'cursor-hook.js', 'mcp-server.js',
];
const hindsightRuntime = (() => {
  if (!hindsight) return null;
  const ca = hindsight.settings.codingAgents;
  const dir = ca.runtimeDir === '~' ? HOME : ca.runtimeDir.startsWith('~/') ? join(HOME, ca.runtimeDir.slice(2)) : ca.runtimeDir;
  let version = null;
  try { version = readJson(join(dir, 'package.json')).version; } catch { /* not staged */ }
  const ready = version === ca.version && HINDSIGHT_HOOK_SCRIPTS.every((f) => existsSync(join(dir, 'dist', f)));
  return { dir, version, ready };
})();

const MARKER = '<!-- rendered by samebrain (bin/render.mjs) — edit global/*.md there, not here -->';
const BLOCK_START = '<!-- samebrain:managed:start -->';
const BLOCK_END = '<!-- samebrain:managed:end -->';
const md = (p) => stripBom(read(p)).trim().replaceAll('{{REPO}}', REPO_DISPLAY);
const HINDSIGHT_GUIDE = hindsight
  ? `\n\n## Long-term memory (Hindsight)\n\nSession start injects a bounded \`<hindsight_memories>\` recall for the current repository next to the shared index, and Claude Code, Codex, Cursor and autonomous opencode conversations are captured to Hindsight automatically. Before assuming context is missing, search the long tail: \`node ${REPO_DISPLAY}/bin/memory-search.mjs "<question>"\` (this repository's bank plus the global bank; exit 3 means Hindsight is unreachable, so fall back to \`memory/topics/\`). Never paste secrets into a conversation: transcripts are retained.`
  : '';
const guardrails = `${md(join(ROOT, 'global', 'guardrails.md'))}${HINDSIGHT_GUIDE}`;
const coordination = md(join(ROOT, 'global', 'coordination.md'));
const addendum = (name) => {
  const p = join(ROOT, 'global', 'addenda', `${name}.md`);
  return existsSync(p) ? `\n\n${md(p)}` : '';
};

const SKILL_RESOURCES = ['references', 'scripts', 'assets', 'agents'];
const skillMarker = (name) => `<!-- rendered by samebrain (bin/render.mjs) — edit skills/${name}/SKILL.md in the repo, not here -->`;

function mergeManagedMarkdown(target, content, label) {
  const live = existsSync(target) ? read(target) : '';
  const block = `${BLOCK_START}\n${content.trim()}\n${BLOCK_END}`;
  const start = live.indexOf(BLOCK_START);
  const end = live.indexOf(BLOCK_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    fail(`${label}: malformed managed block markers; refusing to overwrite`);
  }
  let next;
  if (start !== -1 && end >= start) {
    next = `${live.slice(0, start)}${block}${live.slice(end + BLOCK_END.length)}`;
  } else {
    next = live.trimEnd() ? `${live.trimEnd()}\n\n${block}\n` : `${block}\n`;
  }
  writeIfChanged(target, next, label);
}

function copySkillResources(sourceDir, targetDir, label) {
  const copyTree = (source, target, relative) => {
    for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childSource = join(source, entry.name);
      const childTarget = join(target, entry.name);
      const childRelative = join(relative, entry.name);
      if (entry.isDirectory()) copyTree(childSource, childTarget, childRelative);
      else if (entry.isFile()) copyIfChanged(childSource, childTarget, `${label}/${childRelative.replaceAll('\\', '/')}`);
    }
  };
  for (const resource of SKILL_RESOURCES) {
    const source = join(sourceDir, resource);
    if (existsSync(source)) copyTree(source, join(targetDir, resource), resource);
  }
}

function promptSkillBody(body, sourceDir) {
  const absolute = sourceDir.replaceAll('\\', '/');
  return body.replace(/(?<![A-Za-z0-9_./~-])(?:\.\/)?(references|scripts|assets)\//g,
    (_, resource) => `${absolute}/${resource}/`);
}

function reconcileLegacyCodexSkill(name, current, shared) {
  const target = join(HOME, '.codex', 'skills', name, 'SKILL.md');
  if (!existsSync(target)) return;
  const legacy = read(target);
  const marker = skillMarker(name);
  const sharedWasManaged = shared?.includes(marker);
  if (!legacy.includes(marker) || (legacy !== current && (!sharedWasManaged || legacy !== shared))) return;
  changes.push(`codex: remove redundant ~/.codex/skills/${name}/SKILL.md`);
  if (CHECK) return;
  backupOnce(target);
  rmSync(target);
}

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
// opencode has the samebrain plugin (plugins/samebrain-memory.ts): it injects a
// bounded index automatically and commits/pushes at session end, so its bootstrap
// points at the retrieval tools instead of asking the model to read the file.
const PLUGIN_MEMORY_BOOTSTRAP = `\n\n## Memory bootstrap\n\nShared cross-agent memory is injected automatically by the samebrain opencode plugin — a \`<shared-agent-memory>\` index arrives in your system context each session and updates are committed and pushed at session end. Use \`memory_search\` to pull detail from \`${REPO_DISPLAY}/memory/topics/*.md\` on demand, \`memory_read\` to open a topic, and \`memory_append\` to record a new durable fact (one line, optional topic detail). Keep the index lean.`;
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
// default changing), Factory Droid, Pi, and Kimi Code: global AGENTS.md, detection-gated.
for (const [name, dir] of [
  ['opencode', join(HOME, '.config', 'opencode')],
  ['droid', join(HOME, '.factory')],
  ['pi', join(HOME, '.pi')],
]) {
  if (existsSync(dir)) {
    const bootstrap = name === 'opencode' ? PLUGIN_MEMORY_BOOTSTRAP : MEMORY_BOOTSTRAP;
    writeIfChanged(
      join(dir, 'AGENTS.md'),
      `${MARKER}\n\n${guardrails}\n\n${coordination}${addendum(name)}${bootstrap}\n`,
      `${name}: ${join(dir, 'AGENTS.md')}`,
    );
  }
}
if (existsSync(join(HOME, '.kimi-code'))) {
  writeIfChanged(
    join(HOME, '.kimi-code', 'AGENTS.md'),
    `${MARKER}\n\n${guardrails}\n\n${coordination}${addendum('kimi')}${MEMORY_BOOTSTRAP}\n`,
    'kimi: ~/.kimi-code/AGENTS.md',
  );
}
// OpenClaw owns a rich workspace AGENTS.md of its own. Merge one bounded samebrain
// block instead of replacing that file so native memory, channel, and safety guidance survives.
if (existsSync(join(HOME, '.openclaw'))) {
  mergeManagedMarkdown(
    join(HOME, '.openclaw', 'workspace', 'AGENTS.md'),
    `${MARKER}\n\n${guardrails}\n\n${coordination}${addendum('openclaw')}${MEMORY_BOOTSTRAP}`,
    'openclaw: ~/.openclaw/workspace/AGENTS.md managed block',
  );
}

// ---- 3. MCP ------------------------------------------------------------------------
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

const mcpConfig = readJson(join(ROOT, 'global', 'mcp.json'));
const canonical = mcpConfig.mcpServers ?? {};
const retired = mcpConfig.retiredMcpServers ?? [];
const serverFor = (name, def) => {
  const { targets, os, win, rendered_name, _comment, ...base } = def;
  const eff = process.platform === 'win32' && win ? { ...base, ...win } : base;
  return resolveSecrets(eff, name);
};
// Hindsight's coding-agents MCP server (knowledge pages, reflect, ingest) for the agents whose
// sessions it serves. Resolves its bank from the directory the host starts it in.
const HINDSIGHT_MCP_HARNESS = { claude: 'claude-code', cursor: 'cursor-cli' };
const hindsightMcp = (agent) => (hindsightRuntime?.ready && HINDSIGHT_MCP_HARNESS[agent]
  ? { hindsight: { command: STABLE_NODE, args: [join(hindsightRuntime.dir, 'dist', 'mcp-server.js')], env: { HINDSIGHT_MCP_HARNESS: HINDSIGHT_MCP_HARNESS[agent] } } }
  : {});
const wanted = (agent) => ({
  ...Object.fromEntries(
    Object.entries(canonical)
      .filter(([, d]) => d.targets.includes(agent) && (!d.os || d.os.includes(process.platform)))
      .map(([name, d]) => [d.rendered_name ?? name, serverFor(name, d)]),
  ),
  ...hindsightMcp(agent),
});

// 3a. Cursor: full ownership of ~/.cursor/mcp.json
writeIfChanged(
  join(HOME, '.cursor', 'mcp.json'),
  `${JSON.stringify({ mcpServers: wanted('cursor') }, null, 2)}\n`,
  'cursor: ~/.cursor/mcp.json',
);

// 3b. Claude: merge-by-key into live ~/.claude.json (never delete unmanaged keys, except
// names listed in retiredMcpServers — that is how a removal reaches every machine)
{
  const target = join(HOME, '.claude.json');
  const live = existsSync(target) ? readJson(target) : {};
  const merged = { ...(live.mcpServers ?? {}) };
  let dirty = false;
  for (const name of retired) {
    if (name in merged) { delete merged[name]; dirty = true; }
  }
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
const node = STABLE_NODE; // absolute node path — hooks run outside any shell profile
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
// (e.g. `targets: claude`). Default: claude, cursor, codex. Kimi is opt-in.
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
      const out = `${body}\n\n${skillMarker(name)}\n`;
      const sourceDir = join(skillsDir, name);
      const nativeTargets = [];
      if (targets.includes('claude')) nativeTargets.push([join(HOME, '.claude', 'skills', name), `claude: ~/.claude/skills/${name}`]);
      if (targets.includes('cursor')) nativeTargets.push([join(HOME, '.cursor', 'skills', name), `cursor: ~/.cursor/skills/${name}`]);
      if (targets.includes('hermes')) {
        // Hermes profile skills dir. Defuse stray npx-skills symlinks before writing
        // (writing through one would land in the linked store, e.g. ~/.agents/skills).
        const hermesDir = join(HOME, '.hermes', 'skills', name);
        try { if (lstatSync(hermesDir).isSymbolicLink()) rmSync(hermesDir); } catch {}
        nativeTargets.push([hermesDir, `hermes: ~/.hermes/skills/${name}`]);
      }
      const sharedCodexKimi = targets.includes('codex-skill') && targets.includes('kimi');
      if (sharedCodexKimi || targets.includes('kimi')) {
        nativeTargets.push([join(HOME, '.agents', 'skills', name), `shared: ~/.agents/skills/${name}`]);
      }
      if (targets.includes('codex-skill') && !sharedCodexKimi) {
        nativeTargets.push([join(HOME, '.codex', 'skills', name), `codex: ~/.codex/skills/${name}`]);
      }
      const sharedSkill = join(HOME, '.agents', 'skills', name, 'SKILL.md');
      const sharedBefore = existsSync(sharedSkill) ? read(sharedSkill) : null;
      for (const [targetDir, label] of nativeTargets) {
        writeIfChanged(join(targetDir, 'SKILL.md'), out, `${label}/SKILL.md`);
        copySkillResources(sourceDir, targetDir, label);
      }
      if (sharedCodexKimi) reconcileLegacyCodexSkill(name, out, sharedBefore);
      if (targets.includes('codex')) {
        const prompt = `${promptSkillBody(body, sourceDir)}\n\n${skillMarker(name)}\n`;
        writeIfChanged(join(HOME, '.codex', 'prompts', `${name}.md`), prompt, `codex: ~/.codex/prompts/${name}.md`);
      }
    }
  }
}

// opencode has no skills dir of its own: it discovers them via `skills.paths` in
// ~/.config/opencode/opencode.json. Point it at the rendered Claude dir once and every
// skill targeting `claude` reaches opencode too. Detection-gated, merge-only.
if (existsSync(join(HOME, '.config', 'opencode'))) {
  const claudeSkills = join(HOME, '.claude', 'skills');
  mergeJsonFile(join(HOME, '.config', 'opencode', 'opencode.json'), 'opencode: opencode.json skills.paths', (s) => {
    s.$schema ??= 'https://opencode.ai/config.json';
    s.skills ??= {};
    s.skills.paths ??= [];
    if (!s.skills.paths.includes(claudeSkills)) s.skills.paths.push(claudeSkills);
  });
}
// opencode plugins: canonical sources in plugins/<name>.{ts,js} render to
// ~/.config/opencode/plugins/<name> (auto-discovered by opencode). Detection-gated.
// `{{REPO}}` resolves to this machine's repo path so a plugin isn't tied to one
// directory name — samebrain-memory owns the memory lifecycle; guardrails, notify,
// and telemetry add enforcement, completion alerts, and cost records.
if (existsSync(join(HOME, '.config', 'opencode'))) {
  const pluginsDir = join(ROOT, 'plugins');
  if (existsSync(pluginsDir)) {
    for (const file of readdirSync(pluginsDir)) {
      if (!/\.(ts|js)$/.test(file)) continue;
      const body = read(join(pluginsDir, file)).replaceAll('{{REPO}}', ROOT.replaceAll('\\', '/'));
      writeIfChanged(
        join(HOME, '.config', 'opencode', 'plugins', file),
        `// rendered by samebrain (bin/render.mjs) — edit plugins/${file} in the repo, not here\n${body}`,
        `opencode: ~/.config/opencode/plugins/${file}`,
      );
    }
  }
}
// The plugin imports @opencode-ai/plugin; opencode runs `bun install` for the config
// dir's package.json at startup, so declare the dep (merge-only; never overwrite a pin).
if (existsSync(join(HOME, '.config', 'opencode'))) {
  mergeJsonFile(join(HOME, '.config', 'opencode', 'package.json'), 'opencode: package.json @opencode-ai/plugin', (s) => {
    s.dependencies ??= {};
    s.dependencies['@opencode-ai/plugin'] ??= '1.18.30';
  });
}
// opencode agents: harness-neutral sources live in global/agents/<harness>/<name>.md and
// render to that harness's file-agent dir. Detection-gated on the harness config dir, so a
// machine without opencode is untouched. Owned (full render, backup once) like instructions.
if (existsSync(join(HOME, '.config', 'opencode'))) {
  const srcDir = join(ROOT, 'global', 'agents', 'opencode');
  if (existsSync(srcDir)) {
    const agentDir = join(HOME, '.config', 'opencode', 'agent');
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.md')) continue;
      const out = `${md(join(srcDir, file))}\n\n<!-- rendered by samebrain (bin/render.mjs) — edit global/agents/opencode/${file} in the repo, not here -->\n`;
      writeIfChanged(join(agentDir, file), out, `opencode: ${join(agentDir, file)}`);
    }
  }
}
// ---- 5b. Hindsight long-term memory (opt-in, see global/hindsight.json) --------------------
// Every agent runs the pinned @vectorize-io/hindsight-coding-agents runtime (staged by
// bin/hindsight-activate.mjs): Claude Code and Cursor get its session-start, prompt and stop hooks
// plus its MCP server, Codex its capture hook, opencode its persistent plugin. All of them write the
// same `conversation:<session>` documents into one bank per repository. Hook wiring waits until the
// runtime is staged at the pinned version — a hook pointing at a missing file would error every
// session. Config files carry the API key, so they are written owner-only.
if (hindsight) {
  const { settings: hs } = hindsight;
  const expand = (p) => (p === '~' ? HOME : p.startsWith('~/') ? join(HOME, p.slice(2)) : p);
  const nonRepo = (hs.nonRepoDirs ?? []).map(expand);
  const writePrivateJson = (target, mutate, label) => {
    const live = existsSync(target) ? readJson(target) : {};
    const next = mutate(JSON.parse(JSON.stringify(live)));
    const content = `${JSON.stringify(next, null, 2)}\n`;
    const sameMode = existsSync(target) && (statSync(target).mode & 0o777) === 0o600;
    if (existsSync(target) && read(target) === content && sameMode) return;
    changes.push(label);
    if (CHECK) return;
    backupOnce(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: 0o600 });
    chmodSync(target, 0o600);
  };

  const ca = hs.codingAgents;
  writePrivateJson(expand(ca.configFile), (live) => ({
    ...live,
    ...ca.config,
    apiUrl: hindsight.url,
    apiToken: hindsight.key,
    // Sessions outside a repository resolve to their directory's basename; rename those banks.
    banks: {
      ...(live.banks ?? {}),
      ...Object.fromEntries(nonRepo.map((d) => [basename(d), { bank: hs.globalBank }])),
    },
  }), `hindsight: ${ca.configFile}`);

  // The per-agent hindsight-memory Claude Code plugin is superseded upstream; take back its
  // declaration so injections and tools are not duplicated (activation uninstalls it).
  const retired = hs.retiredClaudePlugin;
  if (retired) {
    mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json retire hindsight-memory plugin', (s) => {
      if (s.enabledPlugins) delete s.enabledPlugins[`${retired.plugin}@${retired.marketplace}`];
      if (s.extraKnownMarketplaces) delete s.extraKnownMarketplaces[retired.marketplace];
    });
  }

  const { dir: runtime, version: runtimeVersion, ready: runtimeReady } = hindsightRuntime;
  if (!runtimeReady) {
    console.log(`render: Hindsight is configured but not activated (coding-agents runtime ${runtimeVersion ?? 'missing'}, want ${ca.version}) — run: node bin/hindsight-activate.mjs`);
  }
  if (runtimeReady) {
    const hookCmd = (file) => `"${node}" "${join(runtime, 'dist', file)}"`;
    const timed = (timeout) => (command) => ({ hooks: [{ type: 'command', command, timeout }] });
    mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json hindsight hooks', (s) => {
      s.hooks ??= {};
      // Synchronous like upstream: headless `claude -p` exits before an async hook finishes, which
      // silently dropped headless-run capture. The retain itself is queued server-side (~0.3s).
      const entry = (command) => ({ matcher: '', ...timed(60)(command) });
      ensureNested(s, 'Stop', hookCmd('claude-stop-hook.js'), join(runtime, 'dist', 'claude-stop-hook.js'), entry);
      // Session start seeds a cold bank (git history, knowledge pages) in the background and
      // injects the knowledge-page roster; each prompt gets the once-per-session reflect plus
      // relevant page sections.
      ensureNested(s, 'SessionStart', hookCmd('claude-sessionstart-hook.js'), join(runtime, 'dist', 'claude-sessionstart-hook.js'), entry);
      ensureNested(s, 'UserPromptSubmit', hookCmd('claude-hook.js'), join(runtime, 'dist', 'claude-hook.js'), (command) => ({ matcher: '', ...timed(30)(command) }));
    });
    mergeJsonFile(join(HOME, '.codex', 'hooks.json'), 'codex: hooks.json hindsight capture hook', (s) => {
      s.hooks ??= {};
      ensureNested(s, 'Stop', hookCmd('codex-stop-hook.js'), join(runtime, 'dist', 'codex-stop-hook.js'), timed(60));
    });
    mergeJsonFile(join(HOME, '.cursor', 'hooks.json'), 'cursor: hooks.json hindsight capture hook', (s) => {
      s.version ??= 1;
      s.hooks ??= {};
      // Same lifecycle as Claude: seed + roster at session start, reflect/page injection per prompt,
      // capture at stop.
      const ensure = (event, file, extra) => {
        const script = join(runtime, 'dist', file);
        const command = hookCmd(file);
        s.hooks[event] ??= [];
        s.hooks[event] = s.hooks[event].filter((h) => h.command === command || !managesScript(h.command, script));
        if (!s.hooks[event].some((h) => h.command === command)) s.hooks[event].push({ command, ...extra });
      };
      ensure('sessionStart', 'cursor-sessionstart-hook.js', { timeout: 30 });
      ensure('beforeSubmitPrompt', 'cursor-hook.js', {});
      ensure('stop', 'cursor-stop-hook.js', { timeout: 30 });
    });
    // One writer: Codex's native memories duplicate what the capture hook retains from Codex
    // sessions, so they are switched off in [features] (section-level edit, rest of the file kept).
    if (hs.codex?.nativeMemories === false && existsSync(join(HOME, '.codex', 'config.toml'))) {
      const target = join(HOME, '.codex', 'config.toml');
      const live = read(target);
      const header = live.match(/^\[features\][^\n]*$/m);
      let next;
      if (!header) {
        next = `${live.replace(/\n*$/, '\n\n')}[features]\nmemories = false\n`;
      } else {
        const start = header.index + header[0].length;
        const rest = live.slice(start);
        const end = start + (rest.search(/^\[/m) === -1 ? rest.length : rest.search(/^\[/m));
        const section = live.slice(start, end);
        const flipped = /^memories\s*=.*$/m.test(section)
          ? section.replace(/^memories\s*=.*$/m, 'memories = false')
          : `\nmemories = false${section}`;
        next = `${live.slice(0, start)}${flipped}${live.slice(end)}`;
      }
      if (next !== live) {
        changes.push('codex: ~/.codex/config.toml features.memories = false (Hindsight is the writer)');
        if (!CHECK) { backupOnce(target); writeFileSync(target, next); }
      }
    }
    // opencode loads the runtime as a persistent plugin (package.json main); it retains every turn.
    if (existsSync(join(HOME, '.config', 'opencode'))) {
      if (existsSync(join(HOME, '.config', 'opencode', 'opencode.jsonc'))) {
        console.log(`render: ~/.config/opencode/opencode.jsonc takes precedence — add "${runtime}" to its "plugin" list by hand`);
      } else {
        mergeJsonFile(join(HOME, '.config', 'opencode', 'opencode.json'), 'opencode: opencode.json hindsight plugin', (s) => {
          s.plugin ??= [];
          if (!s.plugin.includes(runtime)) s.plugin.push(runtime);
        });
      }
    }
  }
}

// OpenClaw loads extra skill roots at the lowest precedence, so workspace and managed
// OpenClaw skills can still override samebrain's rendered Claude-compatible baseline.
if (existsSync(join(HOME, '.openclaw'))) {
  const claudeSkills = join(HOME, '.claude', 'skills');
  mergeJsonFile(join(HOME, '.openclaw', 'openclaw.json'), 'openclaw: openclaw.json skills.load.extraDirs', (s) => {
    s.skills ??= {};
    s.skills.load ??= {};
    s.skills.load.extraDirs ??= [];
    if (!s.skills.load.extraDirs.includes(claudeSkills)) s.skills.load.extraDirs.push(claudeSkills);
  });
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
// auto-continue — Claude only (opencode gets plugins/auto-continue.js). The hook itself
// no-ops outside autonomous sessions (agent-deck or AUTO_CONTINUE=1).
const autoContinue = join(ROOT, 'hooks', 'auto-continue.mjs');
mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json auto-continue hooks', (s) => {
  s.hooks ??= {};
  const entry = (command) => ({ matcher: '', hooks: [{ type: 'command', command }] });
  // One script serves three events; ensureNested dedupes per event (stale node/repo paths).
  ensureNested(s, 'SessionStart', cmd(autoContinue, '--session-start'), autoContinue, entry);
  ensureNested(s, 'UserPromptSubmit', cmd(autoContinue, '--prompt'), autoContinue, entry);
  ensureNested(s, 'Stop', cmd(autoContinue), autoContinue, entry);
  const toolEntry = (command) => ({ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command }] });
  ensureNested(s, 'PreToolUse', cmd(autoContinue, '--pre-tool'), autoContinue, toolEntry);
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

// ---- 6b. Lease hygiene ----------------------------------------------------------------
// coordination/leases/<scope>.lease files are git-committed claims. Nothing deletes an
// expired lease, so dead claims pile up and flood `bin/status.mjs`. Warn when any are
// past the grace window; --gc prunes them (and malformed files, which are never claimable)
// so housekeeping is one command. Grace defaults to 7 days, override with
// SAMEBRAIN_LEASE_GRACE_DAYS.
{
  const leaseDir = join(ROOT, 'coordination', 'leases');
  if (existsSync(leaseDir)) {
    const envGrace = Number(process.env.SAMEBRAIN_LEASE_GRACE_DAYS);
    const graceDays = Number.isFinite(envGrace) && envGrace >= 0 ? envGrace : 7;
    const cutoff = Date.now() - graceDays * 86400000;
    let files = [];
    try { files = readdirSync(leaseDir).filter((f) => f.endsWith('.lease')); } catch { /* unreadable */ }
    let prunable = 0;
    for (const file of files) {
      const path = join(leaseDir, file);
      let dead = false;
      try { dead = Date.parse(JSON.parse(read(path)).expires) < cutoff; }
      catch { dead = true; /* malformed = never claimable */ }
      if (!dead) continue;
      prunable += 1;
      if (GC && !CHECK) { rmSync(path); changes.push(`lease: pruned ${file}`); }
    }
    if (prunable > 0 && !GC) {
      console.log(`render: ${prunable} expired lease(s) past the ${graceDays}-day grace — run: node bin/render.mjs --gc`);
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
