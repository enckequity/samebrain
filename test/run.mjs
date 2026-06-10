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

// 9. secrets.env feeds ${VAR} refs (process env wins over the file)
{
  writeFileSync(join(repo, 'secrets.env'), '# comment\nSB_FILE_TOKEN = from-file\n');
  const cfg = '{ "mcpServers": { "t": { "targets": ["cursor"], "type": "http", '
    + '"url": "https://x.example/${SB_FILE_TOKEN}" } } }';
  writeFileSync(join(repo, 'global', 'mcp.json'), cfg);
  const r = render();
  t('secrets.env resolves refs', r.status === 0 && read(at('.cursor', 'mcp.json')).includes('from-file'));
  const r2 = render({ SB_FILE_TOKEN: 'from-env' });
  t('process env beats secrets.env', r2.status === 0 && read(at('.cursor', 'mcp.json')).includes('from-env'));
}

// 10. Detection gating: no .gemini/.copilot dirs → no files rendered for them
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

// 11. smartloop-stop: dead-man fires only for owned, non-terminal, wake-less runs
{
  const sl = join(work, 'smartloop');
  const mkRun = (slug, fm) => {
    mkdirSync(join(sl, slug), { recursive: true });
    writeFileSync(join(sl, slug, 'state.md'),
      `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n## Contract\n`);
  };
  mkRun('dead-run', { slug: 'dead-run', status: 'working', owner_session: 's1' });
  mkRun('sleeping', { slug: 'sleeping', status: 'waiting:ci', owner_session: 's1', next_wake: '2099-01-01T00:00:00Z' });
  // slug deliberately != 'parked': the hook's stderr guidance names the sentinel value
  mkRun('paused', { slug: 'paused', status: 'waiting:user', owner_session: 's1', next_wake: 'parked' });
  mkRun('finished', { slug: 'finished', status: 'done', owner_session: 's1' });
  mkRun('overdue', { slug: 'overdue', status: 'waiting:wake', owner_session: 's1', next_wake: '2020-01-01T00:00:00Z' });
  mkRun('dirwins', { slug: 'imposter', status: 'working', owner_session: 's1' });
  mkdirSync(join(sl, 'malformed'), { recursive: true });
  writeFileSync(join(sl, 'malformed', 'state.md'), 'no frontmatter here');
  mkdirSync(join(sl, 'brokendir', 'state.md'), { recursive: true }); // unreadable: state.md is a directory
  const stop = (payload) => spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-stop.mjs')], {
    env: { ...env, SMARTLOOP_DIR: sl }, input: JSON.stringify(payload), encoding: 'utf8',
  });
  const r1 = stop({ session_id: 's1' });
  t('dead run blocks stop (exit 2)', r1.status === 2);
  t('stderr names the run', r1.stderr.includes('dead-run'));
  t('stderr spares sleeping/parked/done', !r1.stderr.includes('sleeping') && !r1.stderr.includes('paused') && !r1.stderr.includes('finished'));
  t('expired wake blocks too', r1.status === 2 && r1.stderr.includes('overdue'));
  t('malformed state.md skipped silently', !r1.stderr.includes('malformed'));
  t('unreadable entry does not abort scan', r1.stderr.includes('dead-run') && r1.stderr.includes('overdue'));
  t('directory slug beats frontmatter slug', r1.stderr.includes('dirwins') && !r1.stderr.includes('imposter'));
  t('other session unaffected', stop({ session_id: 's2' }).status === 0);
  t('stop_hook_active passes through', stop({ session_id: 's1', stop_hook_active: true }).status === 0);
  t('no state dir is silent', spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-stop.mjs')], {
    env: { ...env, SMARTLOOP_DIR: join(work, 'absent') }, input: '{"session_id":"s1"}', encoding: 'utf8',
  }).status === 0);
  t('garbage stdin is silent', spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-stop.mjs')], {
    env: { ...env, SMARTLOOP_DIR: sl }, input: 'not json', encoding: 'utf8',
  }).status === 0);
}

// 12. smartloop-sweep: surfaces non-done runs at session start, silent when none
{
  const sl = join(work, 'smartloop'); // fixtures from block 11
  const sweep = (dir) => spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-sweep.mjs')], {
    env: { ...env, SMARTLOOP_DIR: dir }, encoding: 'utf8',
  });
  const r = sweep(sl);
  t('sweep exits 0', r.status === 0);
  t('sweep lists non-done runs', r.stdout.includes('dead-run') && r.stdout.includes('paused') && r.stdout.includes('overdue'));
  t('sweep omits done runs', !r.stdout.includes('finished'));
  t('sweep spares sleeping runs', !r.stdout.includes('sleeping'));
  t('sweep gives resume hint', r.stdout.includes('/smartloop resume'));
  t('sweep silent when no runs', sweep(join(work, 'absent')).stdout.trim() === '');
}

// 13. smartloop: render publishes the skill and registers liveness hooks, idempotently
{
  const r = render();
  t('smartloop render exits 0', r.status === 0);
  const skill = at('.claude', 'skills', 'smartloop', 'SKILL.md');
  t('renders smartloop skill', existsSync(skill));
  t('skill keeps frontmatter first', read(skill).startsWith('---'));
  t('skill carries end marker', read(skill).includes('rendered by samebrain'));
  t('skill marker names its source', read(skill).includes('edit skills/smartloop/SKILL.md'));
  const settings = JSON.parse(read(at('.claude', 'settings.json')));
  const cmds = Object.values(settings.hooks).flat().flatMap((e) => e.hooks ?? []).map((h) => h.command);
  t('stop dead-man registered', cmds.some((c) => c.includes('smartloop-stop.mjs')));
  t('sweep registered', cmds.some((c) => c.includes('smartloop-sweep.mjs')));
  const r2 = render();
  t('smartloop render idempotent', r2.stdout.includes('everything in sync'));
  mkdirSync(join(repo, 'skills', 'bomskill'), { recursive: true });
  writeFileSync(join(repo, 'skills', 'bomskill', 'SKILL.md'), '﻿---\nname: bomskill\ndescription: x\n---\nbody\n');
  render();
  t('BOM stripped from published skill', read(at('.claude', 'skills', 'bomskill', 'SKILL.md')).startsWith('---'));
}

// 14. setup.mjs = render + friendly summary (hook step degrades outside a git clone)
{
  const home3 = join(work, 'home3');
  mkdirSync(home3, { recursive: true });
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'setup.mjs')], {
    env: { ...process.env, HOME: home3, USERPROFILE: home3 }, encoding: 'utf8',
  });
  t('setup exits 0', r.status === 0);
  t('setup renders configs', existsSync(join(home3, '.claude', 'CLAUDE.md')));
  t('setup prints next steps', r.stdout.includes('Make it yours'));
}

rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall tests passed');
process.exit(failures ? 1 : 0);
