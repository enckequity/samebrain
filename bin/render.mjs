#!/usr/bin/env node
// Render canonical agent config to per-agent global files on THIS machine. Idempotent.
//   node bin/render.mjs                     apply
//   node bin/render.mjs --check             report drift, write nothing
//   node bin/render.mjs --memory-only       update memory instructions/hooks/config/MCP only
//   node bin/render.mjs --full              leave persisted memory-only mode and apply everything
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codexHookCommand, hookCommandSource } from './codex-hook-command.mjs';
import { repairPluginCache } from './repair-codex-plugin-hooks.mjs';
import { stableNode } from './stable-node.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = homedir();
const CHECK = process.argv.includes('--check');
const GC = process.argv.includes('--gc');
const ACK = process.argv.includes('--ack-cursor-rules');
const FORCE_FULL = process.argv.includes('--full');
const RENDER_MODE_FILE = join(HOME, '.hindsight', 'samebrain-render-mode');
let savedMemoryOnly = false;
try { savedMemoryOnly = readFileSync(RENDER_MODE_FILE, 'utf8').trim() === 'memory-only'; } catch { /* default full sync */ }
const MEMORY_ONLY = process.argv.includes('--memory-only') || (!FORCE_FULL && savedMemoryOnly);
const read = (p) => readFileSync(p, 'utf8');
const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s); // tolerate editor BOMs
const readJson = (p) => JSON.parse(stripBom(read(p)));
const fail = (msg) => { console.error(`render: ${msg}`); process.exit(1); };
const changes = [];

// A linked worktree (its .git is a file) would write its own path into every global hook,
// MCP and {{REPO}} reference. core.hooksPath is shared, so post-merge fires in task worktrees
// too. Render from the main checkout; --from-worktree is the deliberate override.
const IS_LINKED_WORKTREE = (() => { try { return statSync(join(ROOT, '.git')).isFile(); } catch { return false; } })();
if (IS_LINKED_WORKTREE && !CHECK && !process.argv.includes('--from-worktree')) {
  console.error(`render: ${ROOT} is a linked worktree; skipped so global config keeps pointing at the main checkout. Render from the main checkout, or pass --from-worktree to override.`);
  process.exit(0);
}

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
// SAMEBRAIN_NODE, ~/.local/bin/node(.exe), then the PATH node (`command -v node` from a login
// shell, or `where node` on Windows).
const STABLE_NODE = stableNode();

// Reconcile plugin cache drift on render/check, including memory-only installs.
if (process.platform === 'win32') {
  try {
    repairPluginCache({ node: STABLE_NODE, check: CHECK, report: (label) => changes.push(`codex: ${label}`) });
  } catch (error) {
    console.error(`render: skipped the Windows plugin hook repair (${error.message}); the rest still renders.`);
  }
}

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
const HINDSIGHT_GUIDE_START = '<!-- samebrain:hindsight:start -->';
const HINDSIGHT_GUIDE_END = '<!-- samebrain:hindsight:end -->';
const HINDSIGHT_GUIDE_BODY = hindsight
  ? `## Long-term memory (Hindsight)\n\nSession start injects a bounded \`<hindsight_memories>\` recall for the current repository next to the shared index, and Claude Code, Codex, Cursor and autonomous opencode conversations are captured to Hindsight automatically. During a task, run \`node ${REPO_DISPLAY}/bin/memory-search.mjs "<question>"\` when a past decision, recurring error or unfamiliar system could change what you do; skip it for routine work. It searches this repository's bank plus the global bank, and falls back to \`memory/topics/\` when Hindsight is off or unreachable. To store a dated fact directly: \`node ${REPO_DISPLAY}/bin/memory-retain.mjs --title "<title>" --date YYYY-MM-DD [--global] "<fact + evidence>"\` (the same title replaces it; title a fix \`Correction: <topic>\`). Never paste secrets into a conversation: transcripts are retained.`
  : '';
const HINDSIGHT_GUIDE = HINDSIGHT_GUIDE_BODY ? `\n\n${HINDSIGHT_GUIDE_START}\n${HINDSIGHT_GUIDE_BODY}\n${HINDSIGHT_GUIDE_END}` : '';
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

function updateMemoryGuide(target, label) {
  if (!existsSync(target)) return;
  const live = read(target);
  if (!live.startsWith(MARKER)) return; // memory-only mode never rewrites an unmanaged file
  const block = `${HINDSIGHT_GUIDE_START}\n${HINDSIGHT_GUIDE_BODY}\n${HINDSIGHT_GUIDE_END}`;
  const markedStart = live.indexOf(HINDSIGHT_GUIDE_START);
  const markedEnd = live.indexOf(HINDSIGHT_GUIDE_END);
  let next = live;
  if (markedStart >= 0 && markedEnd > markedStart) {
    next = `${live.slice(0, markedStart)}${block}${live.slice(markedEnd + HINDSIGHT_GUIDE_END.length)}`;
  } else {
    // One-time migration from the unmarked guide used before scoped memory rollout existed.
    const oldStart = live.indexOf('\n\n## Long-term memory');
    const boundary = live.indexOf('\n\n# Multi-Agent Work Coordination', Math.max(0, oldStart));
    if (oldStart >= 0 && boundary >= 0) {
      next = `${live.slice(0, oldStart)}\n\n${block}${live.slice(boundary)}`;
    } else if (boundary >= 0) {
      next = `${live.slice(0, boundary)}\n\n${block}${live.slice(boundary)}`;
    } else {
      next = `${live.trimEnd()}\n\n${block}\n`;
    }
  }
  writeIfChanged(target, next, label);
}

// ---- 1. Codex global instructions -------------------------------------------------
if (MEMORY_ONLY) {
  updateMemoryGuide(join(HOME, '.codex', 'AGENTS.md'), 'codex: ~/.codex/AGENTS.md Hindsight guide');
} else {
  writeIfChanged(
    join(HOME, '.codex', 'AGENTS.md'),
    `${MARKER}\n\n${guardrails}\n\n${coordination}${addendum('codex')}\n`,
    'codex: ~/.codex/AGENTS.md',
  );
}

// ---- 2. Claude global instructions ------------------------------------------------
const rtk = existsSync(join(HOME, '.claude', 'RTK.md')) ? '\n\n@RTK.md' : '';
if (MEMORY_ONLY) {
  updateMemoryGuide(join(HOME, '.claude', 'CLAUDE.md'), 'claude: ~/.claude/CLAUDE.md Hindsight guide');
} else {
  writeIfChanged(
    join(HOME, '.claude', 'CLAUDE.md'),
    `${MARKER}\n\n${guardrails}\n\n${coordination}${addendum('claude')}${rtk}\n`,
    'claude: ~/.claude/CLAUDE.md',
  );
}

// ---- 2b. Gemini CLI / Copilot CLI — rendered only where the agent is installed ------
// No session hooks wired for these yet, so their instructions carry a memory-bootstrap
// line telling the agent to read the shared index itself each session.
// (opencode needs no target: it reads ~/.claude/CLAUDE.md globally by default.)
const MEMORY_BOOTSTRAP = `\n\n## Memory bootstrap\n\nAt the start of each session, read \`${REPO_DISPLAY}/memory/MEMORY.md\` — durable cross-agent facts (details in memory/topics/).`;
// opencode has the samebrain plugin (plugins/samebrain-memory.ts): it injects a
// bounded index automatically and commits/pushes at session end, so its bootstrap
// points at the retrieval tools instead of asking the model to read the file.
const PLUGIN_MEMORY_BOOTSTRAP = hindsight
  ? `\n\n## Memory bootstrap\n\nThe samebrain opencode plugin injects the core index and Hindsight memory into your system context each session. Use \`memory_search\` before assuming context is missing, \`memory_read\` to open an archived topic, and \`memory_retain\` to record a durable fact in Hindsight.`
  : `\n\n## Memory bootstrap\n\nThe samebrain opencode plugin injects the core index into your system context each session. Use \`memory_search\` before assuming context is missing, \`memory_read\` to open a topic, and \`memory_append\` to record a durable fact (one line in the index, detail in memory/topics/).`;
if (!MEMORY_ONLY) {
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
// {{REPO}} and {{NODE}} let a local server point at this checkout's scripts on any machine.
const pathTokens = (value) => JSON.parse(JSON.stringify(value)
  .replaceAll('{{REPO}}', ROOT.replaceAll('\\', '/'))
  .replaceAll('{{NODE}}', STABLE_NODE.replaceAll('\\', '/')));
const serverFor = (name, def) => {
  const { targets, os, win, rendered_name, _comment, ...base } = def;
  const eff = process.platform === 'win32' && win ? { ...base, ...win } : base;
  return resolveSecrets(pathTokens(eff), name);
};
// Hindsight's coding-agents MCP server (knowledge pages, reflect, ingest) for the agents whose
// sessions it serves. Resolves its bank from the directory the host starts it in.
const HINDSIGHT_MCP_HARNESS = { claude: 'claude-code', codex: 'codex', cursor: 'cursor-cli' };
const hindsightMcp = (agent) => (hindsightRuntime?.ready && HINDSIGHT_MCP_HARNESS[agent]
  ? { hindsight: { command: STABLE_NODE, args: [join(hindsightRuntime.dir, 'dist', 'mcp-server.js')], env: { HINDSIGHT_MCP_HARNESS: HINDSIGHT_MCP_HARNESS[agent] } } }
  : {});
const wanted = (agent) => ({
  ...(!MEMORY_ONLY ? Object.fromEntries(
    Object.entries(canonical)
      .filter(([, d]) => d.targets.includes(agent) && (!d.os || d.os.includes(process.platform)))
      .map(([name, d]) => [d.rendered_name ?? name, serverFor(name, d)]),
  ) : {}),
  ...hindsightMcp(agent),
});

// 3a. Cursor: full ownership of ~/.cursor/mcp.json
if (!MEMORY_ONLY) {
  writeIfChanged(
    join(HOME, '.cursor', 'mcp.json'),
    `${JSON.stringify({ mcpServers: wanted('cursor') }, null, 2)}\n`,
    'cursor: ~/.cursor/mcp.json',
  );
}

// 3b. Claude: merge-by-key into live ~/.claude.json (never delete unmanaged keys, except
// names listed in retiredMcpServers — that is how a removal reaches every machine)
{
  const target = join(HOME, '.claude.json');
  const live = existsSync(target) ? readJson(target) : {};
  const merged = { ...(live.mcpServers ?? {}) };
  let dirty = false;
  if (!MEMORY_ONLY) {
    for (const name of retired) {
      if (name in merged) { delete merged[name]; dirty = true; }
    }
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
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Codex rewrites config.toml with indented tables, so headers may carry leading whitespace.
      const header = new RegExp(`^[ \\t]*\\[mcp_servers\\.${escaped}\\][^\\r\\n]*(?:\\r?\\n|$)`, 'm').exec(content);
      if (!header) {
        if (content === '') return section;
        return `${content.replace(/\n*$/, '\n\n')}${section}`;
      }
      const bodyStart = header.index + header[0].length;
      // The section ends at the next header that is not one of its own subtables (e.g. .env).
      const nextHeader = content.slice(bodyStart).search(new RegExp(`^[ \\t]*\\[(?!mcp_servers\\.${escaped}\\.)`, 'm'));
      const end = nextHeader < 0 ? content.length : bodyStart + nextHeader;
      // Keep one blank line before a following table so the merge stays a fixed point.
      return `${content.slice(0, header.index)}${section}${end < content.length ? '\n' : ''}${content.slice(end)}`;
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

// Optional execution defaults, off unless global/execution-permissions.json exists (the template
// ships none). Each client section is optional: claude.defaultMode, opencode.permission, and root
// keys for codex / kimi config.toml. Full render only; --memory-only never changes permissions.
// These are separate from MCP, model selection and approval hooks.
const permissionsFile = join(ROOT, 'global', 'execution-permissions.json');
if (!MEMORY_ONLY && existsSync(permissionsFile)) {
  const permissions = readJson(permissionsFile);
  if (permissions.claude?.defaultMode) {
    mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: standing execution permissions', (s) => {
      s.permissions ??= {};
      s.permissions.defaultMode = permissions.claude.defaultMode;
    });
  }
  if (permissions.opencode?.permission && existsSync(join(HOME, '.config', 'opencode'))) {
    mergeJsonFile(join(HOME, '.config', 'opencode', 'opencode.json'), 'opencode: standing execution permissions', (s) => {
      // Keep explicit tool/account restrictions; set only the broad default.
      s.permission = typeof s.permission === 'object' && s.permission !== null
        ? { '*': permissions.opencode.permission, ...s.permission }
        : permissions.opencode.permission;
      if (typeof s.permission === 'object') s.permission['*'] = permissions.opencode.permission;
    });
    // JSONC loads later than JSON. Edit only its root permission default, keeping comments
    // and per-tool restrictions byte-for-byte; a nested agent permission is not global.
    const jsonc = join(HOME, '.config', 'opencode', 'opencode.jsonc');
    if (existsSync(jsonc)) {
      const live = read(jsonc);
      const tokens = [...live.matchAll(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[{}\[\]:,]/g)]
        .filter((m) => !m[0].startsWith('/'));
      let depth = 0, property = -1;
      for (let i = 0; i < tokens.length; i++) {
        if (depth === 1 && tokens[i][0].startsWith('"') && JSON.parse(tokens[i][0]) === 'permission' && tokens[i + 1]?.[0] === ':') property = i;
        if ('{['.includes(tokens[i][0])) depth++;
        if ('}]'.includes(tokens[i][0])) depth--;
      }
      if (property >= 0) {
        const value = tokens[property + 2];
        let next;
        if (value[0].startsWith('"')) {
          next = live.slice(0, value.index) + JSON.stringify(permissions.opencode.permission) + live.slice(value.index + value[0].length);
        } else if (value[0] === '{') {
          let nested = 1, wildcard;
          for (let i = property + 3; i < tokens.length && nested > 0; i++) {
            if (nested === 1 && tokens[i][0].startsWith('"') && JSON.parse(tokens[i][0]) === '*' && tokens[i + 1]?.[0] === ':') wildcard = tokens[i + 2];
            if ('{['.includes(tokens[i][0])) nested++;
            if ('}]'.includes(tokens[i][0])) nested--;
          }
          if (wildcard && !wildcard[0].startsWith('"')) fail('opencode: JSONC wildcard permission must be a string');
          const pos = wildcard ? wildcard.index : value.index + 1;
          const replacement = wildcard ? JSON.stringify(permissions.opencode.permission)
            : `"*": ${JSON.stringify(permissions.opencode.permission)}${tokens[property + 3]?.[0] === '}' ? '' : ','}`;
          next = live.slice(0, pos) + replacement + live.slice(pos + (wildcard?.[0].length ?? 0));
        } else fail('opencode: unsupported JSONC permission value');
        writeIfChanged(jsonc, next, 'opencode: JSONC standing execution permissions');
      }
    }
  }
  // Both clients keep native execution defaults at the TOML root. Preserve nested profiles,
  // provider credentials, model choices and explicit permission rules byte-for-byte.
  for (const [client, directory] of [['codex', '.codex'], ['kimi', '.kimi-code']]) {
    if (!permissions[client] || (client === 'kimi' && !existsSync(join(HOME, directory)))) continue;
    const target = join(HOME, directory, 'config.toml');
    const live = existsSync(target) ? read(target) : '';
    const firstTable = live.search(/^[ \t]*\[/m);
    let root = firstTable < 0 ? live : live.slice(0, firstTable);
    for (const [key, value] of Object.entries(permissions[client])) {
      const line = `${key} = ${JSON.stringify(value)}`;
      const existing = new RegExp(`^[ \\t]*(?:${key}|"${key}"|'${key}')[ \\t]*=[^\\r\\n]*`, 'm');
      root = existing.test(root) ? root.replace(existing, line) : `${line}\n${root}`;
    }
    writeIfChanged(target, root + (firstTable < 0 ? '' : live.slice(firstTable)), `${client}: standing execution permissions`);
  }
}

// ---- 4. Memory hooks ----------------------------------------------------------------
const node = STABLE_NODE; // absolute node path — hooks run outside any shell profile
const recall = join(ROOT, 'hooks', 'recall.mjs');
const sync = join(ROOT, 'hooks', 'sync.mjs');
const hindsightPrompt = join(ROOT, 'hooks', 'hindsight-prompt.mjs');
const retainBatch = join(ROOT, 'hooks', 'hindsight-retain-batch.mjs');
const codexCmd = (script, flag = '') => codexHookCommand(node, script, flag);
const cmd = (script, flag = '') => `"${node}" "${script}"${flag ? ` ${flag}` : ''}`;
// A hook command is "ours" if it runs a script of the same filename — lets a render
// upgrade a managed command in place (e.g. adding flags) without duplicating it.
const managesScript = (command, script) => new RegExp(`[\\\\/]${basename(script).replaceAll('.', '\\.')}["']`).test(hookCommandSource(command));

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

// Nested {hooks:[{command}]} ensure (Claude/Codex shape). Replace the first managed
// variant in place because Codex hook trust keys include the outer array index. Then
// prune duplicate managed variants.
const ensureNested = (s, event, command, script, mkEntry, matches = (value) => managesScript(value, script)) => {
  s.hooks[event] ??= [];
  const desired = mkEntry(command);
  let kept = false;
  for (let i = 0; i < s.hooks[event].length; i += 1) {
    const entry = s.hooks[event][i];
    if (!entry.hooks) continue;
    const managed = entry.hooks.findIndex((hook) => matches(hook.command));
    if (managed < 0) continue;
    if (!kept) {
      kept = true;
      if (entry.hooks.length === 1 && desired.hooks.length === 1) {
        s.hooks[event][i] = desired;
      } else {
        entry.hooks[managed] = desired.hooks[0];
      }
      entry.hooks = entry.hooks.filter((hook, index) => index === managed || !matches(hook.command));
    } else {
      entry.hooks = entry.hooks.filter((hook) => !matches(hook.command));
    }
  }
  s.hooks[event] = s.hooks[event].filter((e) => !e.hooks || e.hooks.length > 0);
  if (!kept) s.hooks[event].push(desired);
};

// 4a. Claude Code (~/.claude/settings.json) — append-if-absent, preserve existing hooks
mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json memory hooks', (s) => {
  s.hooks ??= {};
  const entry = (command) => ({ matcher: '', hooks: [{ type: 'command', command }] });
  ensureNested(s, 'SessionStart', cmd(recall), recall, entry);
  ensureNested(s, 'SessionEnd', cmd(sync, '--agent claude'), sync, entry);
  if (hindsight) {
    const promptEntry = (command) => ({ matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] });
    ensureNested(s, 'UserPromptSubmit', cmd(hindsightPrompt, '--agent claude'), hindsightPrompt, promptEntry);
  }
  // Retired: guard-context.mjs re-read up to 8MB of transcript on every tool call to warn at
  // 250k tokens; Claude Code already shows context use and auto-compacts.
  const guardContext = join(ROOT, 'hooks', 'guard-context.mjs');
  for (const e of s.hooks.PreToolUse ?? []) if (e.hooks) e.hooks = e.hooks.filter((h) => !managesScript(h.command, guardContext));
  if (s.hooks.PreToolUse) s.hooks.PreToolUse = s.hooks.PreToolUse.filter((e) => !e.hooks || e.hooks.length > 0);
});

// 4a1. Secret redaction at the tool-output boundary: secret-prone Bash commands are
// piped through bin/redact.mjs, and every tool result is scrubbed before the transcript
// stores it. Rendered on every machine, including --memory-only runs. SAMEBRAIN_REDACT=0 turns
// the hook into a no-op.
const redactHook = join(ROOT, 'hooks', 'redact-hook.mjs');
mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json secret redaction hooks', (s) => {
  s.hooks ??= {};
  const entry = (matcher) => (command) => ({ matcher, hooks: [{ type: 'command', command, timeout: 10 }] });
  ensureNested(s, 'PreToolUse', cmd(redactHook), redactHook, entry('Bash'));
  ensureNested(s, 'PostToolUse', cmd(redactHook), redactHook, entry('Bash|PowerShell|WebFetch|mcp__.*'));
});

// 4a2. Optional effort and token defaults, off unless global/token-efficiency.json exists (the
// template ships none). claude.effortLevel and codex.reasoningEffort are applied on every render;
// the other keys are set only when absent, so a per-machine choice sticks:
//   claude: autoCompactWindow, disabledSyncedPlugins ["name", ...], skillOverrides { skill: "off" | "name-only" }
//   codex:  rootDefaults { key: value } (config.toml root), tables { "profiles.x": { key: value } }
const tokenFile = join(ROOT, 'global', 'token-efficiency.json');
const tokenSettings = existsSync(tokenFile) ? readJson(tokenFile) : null;
if (tokenSettings?.claude) {
  const c = tokenSettings.claude;
  mergeJsonFile(join(HOME, '.claude', 'settings.json'), 'claude: settings.json effort + token efficiency', (s) => {
    if (c.effortLevel) s.effortLevel = c.effortLevel;
    if (c.autoCompactWindow !== undefined) s.autoCompactWindow ??= c.autoCompactWindow;
    if (c.disabledSyncedPlugins?.length) {
      s.enabledPlugins ??= {};
      for (const plugin of c.disabledSyncedPlugins) s.enabledPlugins[`${plugin}@synced`] ??= false;
    }
    if (c.skillOverrides && Object.keys(c.skillOverrides).length) {
      s.skillOverrides ??= {};
      for (const [skill, mode] of Object.entries(c.skillOverrides)) s.skillOverrides[skill] ??= mode;
    }
  });
}
if (tokenSettings?.codex && !MEMORY_ONLY && existsSync(join(HOME, '.codex', 'config.toml'))) {
  // Root-table keys: reasoningEffort is replaced in place, rootDefaults are added only when
  // absent. New keys go just before the first [table]; extra tables are appended once.
  const target = join(HOME, '.codex', 'config.toml');
  let live = read(target);
  const cx = tokenSettings.codex;
  const rootKeys = [
    ...(cx.reasoningEffort ? [['model_reasoning_effort', cx.reasoningEffort, true]] : []),
    ...Object.entries(cx.rootDefaults ?? {}).map(([k, v]) => [k, v, false]),
  ];
  for (const [key, value, force] of rootKeys) {
    const firstTable = live.search(/^\s*\[/m);
    const root = firstTable < 0 ? live : live.slice(0, firstTable);
    const rest = firstTable < 0 ? '' : live.slice(firstTable);
    const re = new RegExp(`^${key}\\s*=.*$`, 'm');
    const line = `${key} = ${JSON.stringify(value)}`;
    if (re.test(root)) {
      if (force) live = root.replace(re, line) + rest;
      continue;
    }
    const head = root.trim() ? `${root.replace(/\n*$/, '\n')}` : '';
    live = `${head}${line}\n${rest ? `\n${rest.replace(/^\n+/, '')}` : ''}`;
  }
  for (const [table, body] of Object.entries(cx.tables ?? {})) {
    if (live.split('\n').some((l) => l.trim() === `[${table}]`)) continue;
    const lines = Object.entries(body).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n');
    live = `${live.replace(/\n*$/, '\n')}\n[${table}]\n${lines}\n`;
  }
  writeIfChanged(target, live, 'codex: config.toml effort + token efficiency');
}

// 4b. Codex (~/.codex/hooks.json)
mergeJsonFile(join(HOME, '.codex', 'hooks.json'), 'codex: hooks.json memory hooks', (s) => {
  s.hooks ??= {};
  const entry = (command) => ({ hooks: [{ type: 'command', command }] });
  ensureNested(s, 'SessionStart', codexCmd(recall), recall, entry);
  ensureNested(s, 'Stop', codexCmd(sync, '--agent codex'), sync, entry);
  if (hindsight) {
    const promptEntry = (command) => ({ hooks: [{ type: 'command', command, timeout: process.platform === 'win32' ? 10 : 5 }] });
    ensureNested(s, 'UserPromptSubmit', codexCmd(hindsightPrompt, '--agent codex'), hindsightPrompt, promptEntry);
  }
});

// 4d. Cursor (~/.cursor/hooks.json) — flat {command} entries
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

// Skills, plugins and agents are full-render only; --memory-only leaves them alone.
if (!MEMORY_ONLY) {
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
// (`{{REPO_URL}}` is the same as a file:// URL, required for ESM imports on Windows)
// directory name — samebrain-memory owns the memory lifecycle; guardrails, notify,
// and telemetry add enforcement, completion alerts, and cost records.
if (existsSync(join(HOME, '.config', 'opencode'))) {
  const pluginsDir = join(ROOT, 'plugins');
  if (existsSync(pluginsDir)) {
    for (const file of readdirSync(pluginsDir)) {
      if (!/\.(ts|js)$/.test(file)) continue;
      const target = join(HOME, '.config', 'opencode', 'plugins', file);
      // Import specifiers take {{REPO_URL}}: Node rejects bare Windows drive paths; Bun accepts both.
      const body = read(join(pluginsDir, file))
        .replaceAll('{{REPO_URL}}', pathToFileURL(ROOT).href)
        .replaceAll('{{REPO}}', ROOT.replaceAll('\\', '/'))
        .replaceAll('{{NODE}}', STABLE_NODE.replaceAll('\\', '/'));
      writeIfChanged(
        target,
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
}
// ---- 5b. Hindsight long-term memory (opt-in, see global/hindsight.json) --------------------
// Every agent runs the pinned @vectorize-io/hindsight-coding-agents runtime (staged by
// bin/hindsight-activate.mjs): Claude Code and Cursor get its session-start, prompt and stop hooks,
// Claude Code/Codex/Cursor get its MCP server, Codex gets its capture hook, and opencode its
// persistent plugin. All of them write the
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
    // chmod does not expose a POSIX 0600 mode through stat on Windows; ACL protection is handled
    // by activation. Treat matching bytes as stable there so every render is not false drift.
    const sameMode = existsSync(target) && (process.platform === 'win32' || (statSync(target).mode & 0o777) === 0o600);
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
      ...Object.fromEntries(Object.entries(hs.bankAliases ?? {}).map(([from, bank]) => [from, { bank }])),
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
      // Batched: the wrapper forwards a Stop only after enough new turns or time, and
      // SessionEnd flushes the rest, so long sessions retain in a few large appends.
      const claudeStop = join(runtime, 'dist', 'claude-stop-hook.js');
      ensureNested(s, 'Stop', cmd(retainBatch, `--upstream "${claudeStop}"`), claudeStop, entry);
      ensureNested(s, 'SessionEnd', cmd(retainBatch, `--upstream "${claudeStop}" --flush`), claudeStop, entry);
      ensureNested(s, 'SessionStart', cmd(retainBatch, '--sweep'), retainBatch, (command) => ({ matcher: '', ...timed(10)(command) }));
      // Session start injects the knowledge-page roster. Automatic seeding and reflection stay
      // disabled; hooks/hindsight-prompt.mjs supplies bounded raw relevance recall instead.
      ensureNested(s, 'SessionStart', hookCmd('claude-sessionstart-hook.js'), join(runtime, 'dist', 'claude-sessionstart-hook.js'), entry);
      // claude-hook.js is not installed: with reflection and seeding off it emits nothing yet costs
      // ~0.45s per prompt. Prune any copy left by an earlier render.
      const promptHook = join(runtime, 'dist', 'claude-hook.js');
      for (const e of s.hooks.UserPromptSubmit ?? []) if (e.hooks) e.hooks = e.hooks.filter((h) => !managesScript(h.command, promptHook));
      if (s.hooks.UserPromptSubmit) s.hooks.UserPromptSubmit = s.hooks.UserPromptSubmit.filter((e) => !e.hooks || e.hooks.length > 0);
    });
    mergeJsonFile(join(HOME, '.codex', 'hooks.json'), 'codex: hooks.json hindsight capture hook', (s) => {
      s.hooks ??= {};
      const codexStop = join(runtime, 'dist', 'codex-stop-hook.js');
      // Windows wraps the flags in PowerShell, where only a single-quoted value is taken literally.
      const upstreamFlag = process.platform === 'win32' ? `'--upstream=${codexStop.replaceAll("'", "''")}'` : `--upstream "${codexStop}"`;
      ensureNested(s, 'Stop', codexCmd(retainBatch, upstreamFlag), codexStop, timed(60));
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
    if (hs.codex?.nativeMemories === false) setCodexFeature('memories', 'Hindsight is the writer');
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

// Windows: Codex's shared app-server daemon runs without a console, so every git/shell command it
// launches opens a visible console window (bursts of flashing terminals). With auto-start off, each
// Codex session hosts its own app server inside its terminal and those commands stay hidden.
if ((process.env.SAMEBRAIN_RENDER_PLATFORM ?? process.platform) === 'win32') {
  setCodexFeature('daemon_auto_start', 'Windows: daemon children flash console windows');
}

// Sets one `[features]` key in ~/.codex/config.toml to false, editing only that section and keeping
// Codex's own (indented) formatting.
function setCodexFeature(key, why) {
  const target = join(HOME, '.codex', 'config.toml');
  if (!existsSync(target)) return;
  const live = read(target);
  const header = live.match(/^\[features\][^\n]*$/m);
  const keyLine = new RegExp(`^([ \\t]*)${key}\\s*=.*$`, 'm');
  let next;
  if (!header) {
    next = `${live.replace(/\n*$/, '\n\n')}[features]\n${key} = false\n`;
  } else {
    const start = header.index + header[0].length;
    const rest = live.slice(start);
    const end = start + (rest.search(/^\[/m) === -1 ? rest.length : rest.search(/^\[/m));
    const section = live.slice(start, end);
    const flipped = keyLine.test(section) ? section.replace(keyLine, `$1${key} = false`) : `\n${key} = false${section}`;
    next = `${live.slice(0, start)}${flipped}${live.slice(end)}`;
  }
  if (next !== live) {
    changes.push(`codex: ~/.codex/config.toml features.${key} = false (${why})`);
    if (!CHECK) { backupOnce(target); writeFileSync(target, next); }
  }
}

// OpenClaw loads extra skill roots at the lowest precedence, so workspace and managed
// OpenClaw skills can still override samebrain's rendered Claude-compatible baseline.
if (!MEMORY_ONLY) {
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
  ensureNested(s, 'SessionStart', codexCmd(sweep), sweep, entry);
  ensureNested(s, 'Stop', codexCmd(slStop), slStop, entry);
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
}

// ---- report -------------------------------------------------------------------------
if (changes.length === 0) {
  console.log('render: everything in sync');
} else {
  console.log(`render${MEMORY_ONLY ? ' --memory-only' : ''}${CHECK ? ' --check (no writes)' : ''}:`);
  for (const c of changes) console.log(`  ${CHECK ? 'drift' : 'wrote'}: ${c}`);
}

// Record which engine revision this render applied — the session-start recall hook
// re-renders when HEAD moves past this marker (rebase pulls never fire post-merge).
if (!CHECK) {
  if (MEMORY_ONLY) {
    mkdirSync(dirname(RENDER_MODE_FILE), { recursive: true });
    writeFileSync(RENDER_MODE_FILE, 'memory-only\n');
  } else if (existsSync(RENDER_MODE_FILE)) {
    rmSync(RENDER_MODE_FILE);
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    mkdirSync(join(ROOT, 'backups'), { recursive: true });
    writeFileSync(join(ROOT, 'backups', MEMORY_ONLY ? '.last-memory-render-head' : '.last-render-head'), `${head}\n`);
  } catch { /* not a git clone — marker simply doesn't exist */ }
}
