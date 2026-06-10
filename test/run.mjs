#!/usr/bin/env node
// Self-contained test suite — no framework, no deps. Copies the repo to a temp dir,
// points HOME/USERPROFILE at a fake home, and exercises render + hooks end-to-end.
//   node test/run.mjs        exit 0 = all pass
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'samebrain-test-'));
const repo = join(work, 'repo');
const home = join(work, 'home');
const SKIP = new Set(['.git', 'node_modules', 'backups']);
cpSync(ROOT, repo, { recursive: true, filter: (src) => !SKIP.has(basename(src)) });
mkdirSync(home, { recursive: true });

const env = { ...process.env, HOME: home, USERPROFILE: home };
const render = (extraEnv = {}) =>
  spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs')], {
    env: { ...env, ...extraEnv }, encoding: 'utf8',
  });
const at = (...p) => join(home, ...p);
const read = (p) => readFileSync(p, 'utf8');

let failures = 0;
const t = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failures += 1;
};

// 1. Fresh render writes every target (Gemini/Copilot detected via their dirs)
{
  mkdirSync(at('.gemini'), { recursive: true });
  mkdirSync(at('.copilot'), { recursive: true });
  const r = render();
  t('fresh render exits 0', r.status === 0);
  t('writes claude CLAUDE.md', existsSync(at('.claude', 'CLAUDE.md')));
  t('writes codex AGENTS.md', existsSync(at('.codex', 'AGENTS.md')));
  t('writes cursor mcp.json', existsSync(at('.cursor', 'mcp.json')));
  t('writes claude hooks', existsSync(at('.claude', 'settings.json')));
  t('writes codex hooks', existsSync(at('.codex', 'hooks.json')));
  t('writes cursor hooks', existsSync(at('.cursor', 'hooks.json')));
  t('writes gemini GEMINI.md', existsSync(at('.gemini', 'GEMINI.md')));
  t('writes copilot instructions', existsSync(at('.copilot', 'instructions', 'samebrain.instructions.md')));
  t('gemini gets memory bootstrap', read(at('.gemini', 'GEMINI.md')).includes('Memory bootstrap'));
}

// 2. Idempotence
{
  const r = render();
  t('second render is a no-op', r.stdout.includes('everything in sync'));
}

// 3. {{REPO}} token resolves to the actual repo path
{
  const claudeMd = read(at('.claude', 'CLAUDE.md'));
  t('{{REPO}} token gone', !claudeMd.includes('{{REPO}}'));
  t('repo path substituted', claudeMd.includes(repo.replaceAll('\\', '/')));
}

// 4. BOM-tolerant config + missing secret fails loud
{
  const cfg = '{ "mcpServers": { "t": { "targets": ["claude", "cursor"], "type": "http", '
    + '"url": "https://x.example/", "headers": { "Authorization": "Bearer ${SB_TEST_TOKEN}" } } } }';
  writeFileSync(join(repo, 'global', 'mcp.json'), `﻿${cfg}`);
  const r = render();
  t('missing secret exits 1', r.status === 1);
  t('error names the variable', r.stderr.includes('SB_TEST_TOKEN'));
}

// 5. Secret resolution + merge-only ~/.claude.json
{
  writeFileSync(at('.claude.json'), JSON.stringify({
    mcpServers: { keepme: { type: 'http', url: 'https://keep.example' } },
    unrelatedTopLevelKey: true,
  }));
  const r = render({ SB_TEST_TOKEN: 'resolved-secret-123' });
  t('render with secret exits 0', r.status === 0);
  t('cursor config has resolved secret', read(at('.cursor', 'mcp.json')).includes('resolved-secret-123'));
  const claudeJson = JSON.parse(read(at('.claude.json')));
  t('claude merge keeps unmanaged server', !!claudeJson.mcpServers.keepme);
  t('claude merge keeps unrelated keys', claudeJson.unrelatedTopLevelKey === true);
  t('claude merge adds managed server', claudeJson.mcpServers.t?.headers?.Authorization === 'Bearer resolved-secret-123');
}

// 6. Hook merge preserves pre-existing hooks and stays idempotent
{
  const codexHooks = JSON.parse(read(at('.codex', 'hooks.json')));
  codexHooks.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'echo preexisting' }] });
  writeFileSync(at('.codex', 'hooks.json'), JSON.stringify(codexHooks, null, 2));
  render({ SB_TEST_TOKEN: 'x' });
  const after = JSON.parse(read(at('.codex', 'hooks.json')));
  const cmds = after.hooks.SessionStart.flatMap((e) => e.hooks ?? []).map((h) => h.command);
  t('pre-existing hook preserved', cmds.includes('echo preexisting'));
  t('managed hook not duplicated', cmds.filter((c) => c.includes('recall.mjs')).length === 1);
}

// 7. recall.mjs emits the index (git-less repo copy = offline path)
{
  const r = spawnSync(process.execPath, [join(repo, 'hooks', 'recall.mjs')], { encoding: 'utf8' });
  t('recall exits 0 without git', r.status === 0);
  t('recall emits memory block', r.stdout.includes('<shared-agent-memory'));
  const rc = spawnSync(process.execPath, [join(repo, 'hooks', 'recall.mjs'), '--cursor'], { encoding: 'utf8' });
  let parsed = null;
  try { parsed = JSON.parse(rc.stdout); } catch { /* fails the assertion below */ }
  t('--cursor wraps in JSON contract', typeof parsed?.additional_context === 'string');
}

// 8. Memory token-tax guard fires past the cap
{
  const big = `# index\n${Array.from({ length: 125 }, (_, i) => `- fact ${i}`).join('\n')}\n`;
  writeFileSync(join(repo, 'memory', 'MEMORY.md'), big);
  const r = spawnSync(process.execPath, [join(repo, 'hooks', 'recall.mjs')], { encoding: 'utf8' });
  t('over-cap index triggers warning', r.stdout.includes('WARNING: memory index'));
}

// 9. Detection gating: no .gemini/.copilot dirs → no files rendered for them
{
  const home2 = join(work, 'home2');
  mkdirSync(home2, { recursive: true });
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs')], {
    env: { ...process.env, HOME: home2, USERPROFILE: home2, SB_TEST_TOKEN: 'x' }, encoding: 'utf8',
  });
  t('render without agent dirs exits 0', r.status === 0);
  t('gemini skipped when absent', !existsSync(join(home2, '.gemini', 'GEMINI.md')));
  t('copilot skipped when absent', !existsSync(join(home2, '.copilot', 'instructions', 'samebrain.instructions.md')));
}

rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall tests passed');
process.exit(failures ? 1 : 0);
