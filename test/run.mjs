#!/usr/bin/env node
// Self-contained test suite — no framework, no deps. Copies the repo to a temp dir,
// points HOME/USERPROFILE at a fake home, and exercises render + hooks end-to-end.
//   node test/run.mjs        exit 0 = all pass
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'samebrain-test-'));
const repo = join(work, 'repo');
const home = join(work, 'home');
// Instance data must not leak into the fixture repo: consumers run this suite inside
// template instances that carry real telemetry and a machine-local rules ack.
const SKIP = new Set(['.git', 'node_modules', 'backups', 'telemetry', '.cursor-rules-ack', 'dashboard.html']);
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

// 15. Skills render to every agent; `targets:` frontmatter limits the audience
{
  render({ SB_FILE_TOKEN: 'x' });
  t('memory-gc skill renders to claude', existsSync(at('.claude', 'skills', 'memory-gc', 'SKILL.md')));
  t('memory-gc skill renders to cursor', existsSync(at('.cursor', 'skills', 'memory-gc', 'SKILL.md')));
  t('memory-gc skill renders to codex prompts', existsSync(at('.codex', 'prompts', 'memory-gc.md')));
  t('smartloop renders to every agent (v5: agent-neutral)',
    existsSync(at('.cursor', 'skills', 'smartloop', 'SKILL.md')) && existsSync(at('.codex', 'prompts', 'smartloop.md')));
  t('cursor skill carries repo-path substitution', !read(at('.cursor', 'skills', 'memory-gc', 'SKILL.md')).includes('{{REPO}}'));
}

// 16. sync.mjs appends one telemetry record per session (git-less copy = offline path)
{
  const syncRun = (args, input) => spawnSync(process.execPath, [join(repo, 'hooks', 'sync.mjs'), ...args], {
    env, input, encoding: 'utf8',
  });
  const r = syncRun(['--agent', 'claude'], JSON.stringify({ session_id: 'sess-1', cwd: '/some/project' }));
  t('sync exits 0 without git', r.status === 0);
  const machine = hostname().split('.')[0];
  const month = new Date().toISOString().slice(0, 7);
  const telFile = join(repo, 'telemetry', machine, `${month}.jsonl`);
  t('telemetry record written', existsSync(telFile));
  const rec = JSON.parse(read(telFile).trim().split('\n').at(-1));
  t('record carries agent flag', rec.agent === 'claude');
  t('record carries session id', rec.session_id === 'sess-1');
  t('record hashes cwd, not raw path', typeof rec.cwd_hash === 'string' && !JSON.stringify(rec).includes('/some/project'));
  const r2 = syncRun(['--agent', 'cursor'], 'not json');
  t('garbage stdin still records (nulls)', r2.status === 0
    && JSON.parse(read(telFile).trim().split('\n').at(-1)).session_id === null);
  t('one line per session', read(telFile).trim().split('\n').length === 2);
}

// 16b. smartloop run-summary format (specified in SKILL.md) round-trips through a parser
{
  const sample = { ts: '2026-06-10T12:00:00Z', slug: 'fix-ci', outcome: 'done', iters: 4, wall_s: 1800, verdicts: [] };
  const dir = join(repo, 'telemetry', 'testbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'smartloop-runs.jsonl'), `${JSON.stringify(sample)}\n`);
  const parsed = read(join(dir, 'smartloop-runs.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
  const KEYS = ['ts', 'slug', 'outcome', 'iters', 'wall_s', 'verdicts'];
  t('run summary parses with exact contract keys', parsed.length === 1
    && JSON.stringify(Object.keys(parsed[0]).sort()) === JSON.stringify([...KEYS].sort()));
  t('skill text pins the same contract keys', KEYS.every((k) => read(join(repo, 'skills', 'smartloop', 'SKILL.md')).includes(`"${k}"`)));
}

// 17. Telemetry hygiene: --gc rolls old months; current month >1MB warns
{
  const dir = join(repo, 'telemetry', 'gcbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2020-01.jsonl'),
    '{"ts":"2020-01-01T00:00:00Z","agent":"claude"}\n{"ts":"2020-01-02T00:00:00Z","agent":"codex"}\n');
  const month = new Date().toISOString().slice(0, 7);
  writeFileSync(join(dir, `${month}.jsonl`), `${'{"agent":"claude"}'.padEnd(1024, ' ')}\n`.repeat(1100));
  const r1 = render({ SB_FILE_TOKEN: 'x' });
  t('oversize current month warns', r1.stdout.includes('exceeds 1MB'));
  t('plain render leaves old months alone', existsSync(join(dir, '2020-01.jsonl')));
  const r2 = spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs'), '--gc'], {
    env: { ...env, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  t('--gc exits 0', r2.status === 0);
  t('--gc removes the old month file', !existsSync(join(dir, '2020-01.jsonl')));
  const archive = JSON.parse(read(join(dir, 'archive.jsonl')).trim());
  t('--gc archives a per-month summary', archive.month === '2020-01' && archive.sessions === 2 && archive.by_agent.claude === 1);
  t('--gc spares the current month', existsSync(join(dir, `${month}.jsonl`)));
  rmSync(join(dir, `${month}.jsonl`)); // don't trip later size warnings
}

// 18. Codex MCP opt-in: targets ["codex"] merges into ~/.codex/config.toml, section-level
{
  writeFileSync(join(repo, 'global', 'mcp.json'), JSON.stringify({
    mcpServers: {
      mytool: { targets: ['codex'], command: 'npx', args: ['-y', 'mytool-mcp'], env: { KEY: '${SB_FILE_TOKEN}' } },
    },
  }));
  writeFileSync(at('.codex', 'config.toml'),
    '[model]\nname = "gpt-5"\n\n[mcp_servers.other]\ncommand = "keep-me"\n');
  const r = render({ SB_FILE_TOKEN: 'tok123' });
  t('codex toml render exits 0', r.status === 0);
  const toml = read(at('.codex', 'config.toml'));
  t('managed server section added', toml.includes('[mcp_servers.mytool]') && toml.includes('command = "npx"'));
  t('secrets resolved into toml', toml.includes('KEY = "tok123"'));
  t('claude-only "type" key dropped', !toml.includes('type ='));
  t('unmanaged sections preserved', toml.includes('[model]') && toml.includes('name = "gpt-5"') && toml.includes('[mcp_servers.other]'));
  const r2 = render({ SB_FILE_TOKEN: 'tok123' });
  t('codex toml merge idempotent', !r2.stdout.includes('config.toml'));
  const r3 = render({ SB_FILE_TOKEN: 'tok456' });
  t('changed secret updates managed section in place', read(at('.codex', 'config.toml')).includes('KEY = "tok456"')
    && !read(at('.codex', 'config.toml')).includes('tok123'));
}

// 19. Cursor User Rules drift check: nag until --ack-cursor-rules, re-nag on change
{
  const renderArgs = (...args) => spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs'), ...args], {
    env: { ...env, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  t('unacked rules nag', renderArgs().stdout.includes('cursor-user-rules.md changed'));
  t('--ack-cursor-rules acknowledges', renderArgs('--ack-cursor-rules').stdout.includes('acknowledged'));
  t('acked rules are silent', !renderArgs().stdout.includes('cursor-user-rules.md changed'));
  writeFileSync(join(repo, 'global', 'cursor-user-rules.md'), 'new canonical rules\n');
  t('edited rules re-nag', renderArgs().stdout.includes('cursor-user-rules.md changed'));
}

// 20. Managed hook commands upgrade in place (no duplicates when flags change)
{
  const oldCmd = `"${process.execPath}" "${join(repo, 'hooks', 'sync.mjs')}"`; // pre-v2 form, no --agent
  const live = JSON.parse(read(at('.codex', 'hooks.json')));
  live.hooks.Stop = [{ hooks: [{ type: 'command', command: oldCmd }] }, { hooks: [{ type: 'command', command: 'echo mine' }] }];
  writeFileSync(at('.codex', 'hooks.json'), JSON.stringify(live, null, 2));
  render({ SB_FILE_TOKEN: 'x' });
  const cmds = JSON.parse(read(at('.codex', 'hooks.json'))).hooks.Stop.flatMap((e) => e.hooks ?? []).map((h) => h.command);
  t('stale managed command replaced', !cmds.includes(oldCmd));
  t('upgraded command present once', cmds.filter((c) => c.includes('sync.mjs')).length === 1);
  t('upgraded command carries agent flag', cmds.some((c) => c.includes('--agent codex')));
  t('user hook untouched by upgrade', cmds.includes('echo mine'));
}

// 22. dashboard.mjs: static page from telemetry fixtures, no server, gitignored
{
  const dir = join(repo, 'telemetry', 'dashbox');
  mkdirSync(dir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  writeFileSync(join(dir, `${month}.jsonl`),
    '{"ts":"2026-06-10T01:00:00Z","agent":"claude"}\n{"ts":"2026-06-10T02:00:00Z","agent":"claude"}\n{"ts":"2026-06-10T03:00:00Z","agent":"codex"}\n');
  writeFileSync(join(dir, 'archive.jsonl'), '{"month":"2025-01","machine":"dashbox","sessions":7,"by_agent":{"cursor":7}}\n');
  writeFileSync(join(dir, 'smartloop-runs.jsonl'),
    '{"ts":"2026-06-10T04:00:00Z","slug":"dash-run","outcome":"done","iters":3,"wall_s":600,"verdicts":[{"lens":"security","verdict":"pass","reason":"ok"}]}\n');
  writeFileSync(join(dir, 'fleet-runs.jsonl'),
    '{"ts":"2026-06-10T05:00:00Z","slug":"fleet-task-1","repo":"demo","title":"T","vendor":"claude","outcome":"done","cost_usd":0,"verify_ok":true}\n'
    + '{"ts":"2026-06-10T06:00:00Z","slug":"fleet-task-1","repo":"demo","title":"x</script><b>boom","vendor":"claude","outcome":"done","cost_usd":0,"verify_ok":true}\n');
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'dashboard.mjs')], { env, encoding: 'utf8' });
  t('dashboard exits 0', r.status === 0);
  const html = read(join(repo, 'dashboard.html'));
  t('dashboard inlines sessions per machine/agent', html.includes('dashbox') && html.includes(`"${month}"`));
  t('dashboard includes archived months', html.includes('2025-01'));
  t('dashboard lists smartloop runs with verdicts', html.includes('dash-run') && html.includes('security'));
  t('dashboard lists fleet runs with source tag', html.includes('fleet-task-1') && html.includes('"source":"fleet"'));
  t('fleet re-runs do not count as smartloop regret', html.includes('"regrets":0'));
  t('telemetry strings cannot break out of the inline script', html.split('</script>').length === 2);
  t('dashboard reports memory health', html.includes('Memory index health'));
  t('dashboard.html is gitignored', read(join(repo, '.gitignore')).includes('dashboard.html'));
}

// 23. export.mjs: eval-dataset formats over the trace corpus, schema-shape asserted
{
  const sl = join(work, 'export-state');
  mkdirSync(join(sl, 'dash-run'), { recursive: true });
  writeFileSync(join(sl, 'dash-run', 'state.md'),
    '---\nslug: dash-run\nstatus: done\nowner_session: s1\n---\n## Contract\nGoal: Fix the dashboard\n');
  const exp = (...args) => spawnSync(process.execPath, [join(repo, 'bin', 'export.mjs'), ...args], {
    env: { ...env, SMARTLOOP_DIR: sl }, encoding: 'utf8',
  });
  const de = exp('--format', 'deepeval');
  t('deepeval export exits 0', de.status === 0);
  const cases = JSON.parse(de.stdout);
  const c = cases.find((x) => x.metadata.slug === 'dash-run');
  t('deepeval is a JSON array of test cases', Array.isArray(cases) && cases.length >= 1);
  t('deepeval joins contract goal from state file', c?.input === 'Fix the dashboard');
  t('deepeval case shape', c && 'actual_output' in c && 'expected_output' in c && Array.isArray(c.metadata.verdicts));
  const oe = exp('--format', 'openai-evals');
  const lines = oe.stdout.trim().split('\n').map((l) => JSON.parse(l));
  t('openai-evals is JSONL with input/ideal', lines.length >= 1
    && lines.every((l) => l.input?.[0]?.role === 'user' && typeof l.ideal === 'string'));
  const tx = exp('--format', 'text');
  t('text export is tab-separated', tx.stdout.includes('dash-run\tdone\t3\t600'));
  t('unknown format fails loud', exp('--format', 'csv').status === 1);
}

// 24. status.mjs: fleet view from telemetry + leases, degrades without git history
{
  const leases = join(repo, 'coordination', 'leases');
  mkdirSync(leases, { recursive: true });
  writeFileSync(join(leases, 'repo-x.lease'), JSON.stringify({ owner: 'claude@dashbox', expires: '2099-01-01T00:00:00Z' }));
  writeFileSync(join(leases, 'repo-y.lease'), JSON.stringify({ owner: 'codex@oldbox', expires: '2020-01-01T00:00:00Z' }));
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'status.mjs')], { env, encoding: 'utf8' });
  t('status exits 0 without git history', r.status === 0);
  t('status lists machines with session counts', r.stdout.includes('machine dashbox: 3 session(s)'));
  t('status summarizes smartloop runs', /smartloop: \d+ run\(s\) recorded/.test(r.stdout));
  t('status summarizes fleet runs', /fleet: \d+ run\(s\) recorded/.test(r.stdout));
  t('status shows live lease', r.stdout.includes('lease repo-x: held by claude@dashbox'));
  t('status flags expired lease', r.stdout.includes('lease repo-y: EXPIRED'));
  rmSync(leases, { recursive: true }); // v3 only reads leases; fixtures shouldn't leak into later renders
}

// 25. setup --opensync prints the adapter install steps (never auto-installs)
{
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'setup.mjs'), '--opensync'], {
    env: { ...env, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  t('setup --opensync exits 0', r.status === 0);
  t('opensync plugins printed', ['claude-code-sync', 'codex-sync', 'cursor-sync-plugin'].every((p) => r.stdout.includes(p)));
  t('opensync names the local alternative', r.stdout.includes('dashboard.mjs'));
  t('opensync is print-only (no npm exec)', !read(join(repo, 'bin', 'setup.mjs')).match(/spawnSync\([^)]*npm/));
}

// 26. Cross-machine resume: park on clone A, resume on clone B (the documented sequence)
{
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const remote = join(work, 'state-remote.git');
  const a = join(work, 'machine-a');
  const b = join(work, 'machine-b');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  g(work, 'clone', remote, a);
  g(work, 'clone', remote, b);
  for (const c of [a, b]) { g(c, 'config', 'user.email', 't@t'); g(c, 'config', 'user.name', 't'); }
  mkdirSync(join(a, 'demo-task'), { recursive: true });
  writeFileSync(join(a, 'demo-task', 'state.md'),
    '---\nslug: demo-task\nstatus: waiting:user\nowner_session: sA\nowner_machine: machine-a\nnext_wake: parked\n---\n## Contract\nGoal: demo\n');
  g(a, 'add', '-A'); g(a, 'commit', '-m', 'smartloop: demo-task parked'); g(a, 'push');
  g(b, 'pull', '--rebase', '--autostash');
  t('parked state resumes on second clone', read(join(b, 'demo-task', 'state.md')).includes('status: waiting:user'));
  t('resume procedure is documented', existsSync(join(repo, 'docs', 'cross-machine-resume.md')));
  t('skill carries sync + takeover protocol', read(join(repo, 'skills', 'smartloop', 'SKILL.md')).includes('SMARTLOOP_SYNC_REMOTE')
    && read(join(repo, 'skills', 'smartloop', 'SKILL.md')).includes('owner_machine'));
  t('verdicts are schema-pinned in the skill', read(join(repo, 'skills', 'smartloop', 'SKILL.md')).includes('"lens"'));
}

// 27. lease-check: mechanical claims — double-claim blocked, expiry honored
{
  const lease = (...args) => spawnSync(process.execPath, [join(repo, 'hooks', 'lease-check.mjs'), ...args], {
    env, encoding: 'utf8',
  });
  t('claim a free scope', lease('claim', 'repo-alpha', '--owner', 'claude@boxa').status === 0);
  const dbl = lease('claim', 'repo-alpha', '--owner', 'codex@boxb');
  t('double-claim blocked (exit 2)', dbl.status === 2);
  t('blocker names the holder', dbl.stderr.includes('claude@boxa'));
  t('same owner renews freely', lease('claim', 'repo-alpha', '--owner', 'claude@boxa').status === 0);
  t('check reports held (exit 2)', lease('check', 'repo-alpha').status === 2);
  t('foreign release blocked', lease('release', 'repo-alpha', '--owner', 'codex@boxb').status === 2);
  t('owner releases', lease('release', 'repo-alpha', '--owner', 'claude@boxa').status === 0);
  t('released scope is free', lease('check', 'repo-alpha').status === 0);
  writeFileSync(join(repo, 'coordination', 'leases', 'stale.lease'),
    JSON.stringify({ owner: 'ghost@gone', expires: '2020-01-01T00:00:00Z' }));
  t('expired lease is claimable', lease('claim', 'stale', '--owner', 'claude@boxa').status === 0);
  t('scope names are sanitized', lease('claim', 'Repo/With Spaces!', '--owner', 'x').status === 0
    && existsSync(join(repo, 'coordination', 'leases', 'repo-with-spaces-.lease')));
  t('usage error exits 1', lease('grab', 'x').status === 1);
  rmSync(join(repo, 'coordination'), { recursive: true });
}

// 28. optimize.mjs: DSPy export, pacing addendum, regret suggestions — all from fixtures
{
  const dir = join(repo, 'telemetry', 'regretbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'smartloop-runs.jsonl'), [
    '{"ts":"2026-06-01T00:00:00Z","slug":"flaky-task","outcome":"done","iters":2,"wall_s":300,"verdicts":[]}',
    '{"ts":"2026-06-05T00:00:00Z","slug":"flaky-task","outcome":"done","iters":5,"wall_s":900,"verdicts":[]}',
    '{"ts":"2026-06-06T00:00:00Z","slug":"solid-task","outcome":"done","iters":1,"wall_s":120,"verdicts":[]}',
  ].join('\n') + '\n');
  const opt = (...args) => spawnSync(process.execPath, [join(repo, 'bin', 'optimize.mjs'), ...args], {
    env, encoding: 'utf8',
  });
  const de = opt('--export-dspy');
  const examples = de.stdout.trim().split('\n').map((l) => JSON.parse(l));
  t('dspy export is one JSONL example per run', de.status === 0 && examples.length >= 3);
  t('dspy examples carry task/outcome/iters', examples.every((e) => 'task' in e && 'outcome' in e && 'iters' in e));
  const pc = opt('--pacing');
  const addendum = join(repo, 'global', 'addenda', 'smartloop-pacing.md');
  t('pacing writes the addendum', pc.status === 0 && existsSync(addendum));
  t('pacing addendum carries stats + generated marker',
    read(addendum).includes('median') && read(addendum).includes('generated by bin/optimize.mjs'));
  const rg = opt('--regret');
  t('regret flags done-then-redone slug', rg.stdout.includes('flaky-task') && rg.stdout.includes('tier higher'));
  t('regret spares clean slugs', !rg.stdout.includes('solid-task'));
  t('no flags exits 1', opt().status === 1);
}

// 29. rule-mine skill + lease protocol render into agent instructions
{
  render({ SB_FILE_TOKEN: 'x' });
  t('rule-mine renders to all agents', existsSync(at('.claude', 'skills', 'rule-mine', 'SKILL.md'))
    && existsSync(at('.cursor', 'skills', 'rule-mine', 'SKILL.md')) && existsSync(at('.codex', 'prompts', 'rule-mine.md')));
  const skill = read(at('.claude', 'skills', 'rule-mine', 'SKILL.md'));
  t('rule-mine is PR-gated, never self-merged', skill.includes('human-merged') && skill.includes('Never merge'));
  t('rule-mine resolves repo path', !skill.includes('{{REPO}}'));
  const claudeMd = read(at('.claude', 'CLAUDE.md'));
  t('coordination carries the lease protocol', claudeMd.includes('lease-check.mjs claim'));
  t('rendered instructions carry adversarial review loop', claudeMd.includes('Adversarial Review Loop')
    && read(at('.codex', 'AGENTS.md')).includes('Adversarial Review Loop'));
}

// 30. Wider agent matrix: opencode / Factory Droid / Pi, detection-gated like Gemini/Copilot
{
  const home4 = join(work, 'home4');
  mkdirSync(join(home4, '.config', 'opencode'), { recursive: true });
  mkdirSync(join(home4, '.factory'), { recursive: true });
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs')], {
    env: { ...process.env, HOME: home4, USERPROFILE: home4, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  t('matrix render exits 0', r.status === 0);
  t('opencode gets AGENTS.md', existsSync(join(home4, '.config', 'opencode', 'AGENTS.md')));
  t('droid gets AGENTS.md', existsSync(join(home4, '.factory', 'AGENTS.md')));
  t('pi skipped when absent', !existsSync(join(home4, '.pi', 'AGENTS.md')));
  t('matrix targets carry memory bootstrap', read(join(home4, '.config', 'opencode', 'AGENTS.md')).includes('Memory bootstrap'));
}

// 31. Cross-agent smartloop: liveness hooks in all three agents; cursor/codex payload shapes
{
  render({ SB_FILE_TOKEN: 'x' });
  const codexCmds = JSON.parse(read(at('.codex', 'hooks.json')));
  const codexAll = Object.values(codexCmds.hooks).flat().flatMap((e) => e.hooks ?? []).map((h) => h.command);
  t('codex gets smartloop liveness hooks', codexAll.some((c) => c.includes('smartloop-sweep.mjs'))
    && codexAll.some((c) => c.includes('smartloop-stop.mjs')));
  const cursorCmds = JSON.parse(read(at('.cursor', 'hooks.json')));
  const cursorAll = Object.values(cursorCmds.hooks).flat().map((h) => h.command);
  t('cursor gets smartloop liveness hooks', cursorAll.some((c) => c.includes('smartloop-sweep.mjs') && c.includes('--cursor'))
    && cursorAll.some((c) => c.includes('smartloop-stop.mjs')));
  const sl = join(work, 'smartloop-x');
  mkdirSync(join(sl, 'cursor-run'), { recursive: true });
  writeFileSync(join(sl, 'cursor-run', 'state.md'),
    '---\nslug: cursor-run\nstatus: working\nowner_session: conv-9\n---\n## Contract\n');
  const stop = (payload) => spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-stop.mjs')], {
    env: { ...env, SMARTLOOP_DIR: sl }, input: JSON.stringify(payload), encoding: 'utf8',
  });
  t('stop audit accepts cursor conversation_id', stop({ conversation_id: 'conv-9' }).status === 2);
  t('foreign conversation passes', stop({ conversation_id: 'conv-other' }).status === 0);
  const sw = spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-sweep.mjs'), '--cursor'], {
    env: { ...env, SMARTLOOP_DIR: sl }, encoding: 'utf8',
  });
  let wrapped = null;
  try { wrapped = JSON.parse(sw.stdout); } catch { /* fails assertion */ }
  t('sweep --cursor wraps in JSON contract', typeof wrapped?.additional_context === 'string'
    && wrapped.additional_context.includes('cursor-run'));
  const skill = read(join(repo, 'skills', 'smartloop', 'SKILL.md'));
  t('skill carries the adapter table', skill.includes('## Agent adapters') && skill.includes('park-only'));
  t('skill carries adversarial review evidence contract',
    skill.includes('evidence/adversarial-review.jsonl') && skill.includes('fix delta'));
}

// 32. Portfolio mode: ordered drain queue — cheap first, limit-paused deferred
{
  const sl = join(work, 'portfolio');
  const mk = (slug, status, journalLines) => {
    mkdirSync(join(sl, slug), { recursive: true });
    writeFileSync(join(sl, slug, 'state.md'),
      `---\nslug: ${slug}\nstatus: ${status}\nowner_session: s1\n---\n## Contract\nGoal: x\n## Journal\n${
        Array.from({ length: journalLines }, (_, i) => `- iter ${i}`).join('\n')}\n## Next action\nz\n`);
  };
  mk('heavy-run', 'working', 40);
  mk('light-run', 'waiting:ci', 3);
  mk('paused-run', 'limit-paused', 10);
  mk('done-run', 'done', 5);
  const r = spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-sweep.mjs'), '--portfolio'], {
    env: { ...env, SMARTLOOP_DIR: sl }, encoding: 'utf8',
  });
  t('portfolio exits 0', r.status === 0);
  const order = r.stdout;
  t('cheapest rehydrate first', order.indexOf('1. light-run') !== -1 && order.indexOf('2. heavy-run') !== -1);
  t('limit-paused deferred to the end', order.includes('deferred: paused-run')
    && order.indexOf('deferred: paused-run') > order.indexOf('heavy-run'));
  t('done runs excluded from the portfolio', !order.includes('done-run'));
  t('portfolio silent when empty', spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-sweep.mjs'), '--portfolio'], {
    env: { ...env, SMARTLOOP_DIR: join(work, 'absent') }, encoding: 'utf8',
  }).stdout.trim() === '');
}

// 33. Bounded tier self-tuning: --apply-tiers needs declared bounds, clamps inside them
{
  const opt = (...args) => spawnSync(process.execPath, [join(repo, 'bin', 'optimize.mjs'), ...args], {
    env, encoding: 'utf8',
  });
  const noBounds = opt('--apply-tiers');
  t('apply-tiers without bounds refuses (exit 1)', noBounds.status === 1 && noBounds.stderr.includes('smartloop-bounds.json'));
  writeFileSync(join(repo, 'global', 'smartloop-bounds.json'), '{"floor": 1, "ceiling": 2}\n');
  const tiersFile = join(repo, 'global', 'addenda', 'smartloop-tiers.md');
  t('apply-tiers writes within bounds', opt('--apply-tiers').status === 0
    && read(tiersFile).includes('flaky-task: verify at tier >= 2'));
  t('tiers file carries generated marker + bounds pointer', read(tiersFile).includes('generated by bin/optimize.mjs')
    && read(tiersFile).includes('smartloop-bounds.json'));
  writeFileSync(join(repo, 'global', 'smartloop-bounds.json'), '{"floor": 0, "ceiling": 1}\n');
  t('ceiling clamps the applied tier', opt('--apply-tiers').status === 0
    && read(tiersFile).includes('flaky-task: verify at tier >= 1'));
  writeFileSync(join(repo, 'global', 'smartloop-bounds.json'), '{"floor": 2, "ceiling": 1}\n');
  t('inverted bounds rejected', opt('--apply-tiers').status === 1);
  t('skill points at the learned tier floors', read(join(repo, 'skills', 'smartloop', 'SKILL.md')).includes('smartloop-tiers.md'));
}

// 34. Dashboard v2: rule-effectiveness panel from guardrail hash + correction proxies
{
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'dashboard.mjs')], { env, encoding: 'utf8' });
  t('dashboard v2 exits 0', r.status === 0);
  const html = read(join(repo, 'dashboard.html'));
  t('dashboard shows rule effectiveness', html.includes('Rule effectiveness'));
  t('dashboard counts redone runs as correction pressure', html.includes('"regrets":1'));
  t('dashboard carries guardrails hash', /"hash":"[0-9a-f]{12}"/.test(html));
}

// 35. Recall re-renders when the engine revision changed (rebase pulls skip post-merge)
{
  const g = (...args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  g('init');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('add', '-A');
  g('commit', '-m', 'engine state', '--quiet');
  const home5 = join(work, 'home5');
  mkdirSync(home5, { recursive: true });
  const recall = () => spawnSync(process.execPath, [join(repo, 'hooks', 'recall.mjs')], {
    env: { ...process.env, HOME: home5, USERPROFILE: home5, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  const r1 = recall();
  t('recall still emits memory after render hook-in', r1.status === 0 && r1.stdout.includes('<shared-agent-memory'));
  t('first recall renders the engine', existsSync(join(home5, '.claude', 'CLAUDE.md')));
  t('render records the applied revision', read(join(repo, 'backups', '.last-render-head')).trim()
    === g('rev-parse', 'HEAD').toString().trim());
  rmSync(join(home5, '.claude', 'CLAUDE.md'));
  recall();
  t('unchanged engine: recall does not re-render', !existsSync(join(home5, '.claude', 'CLAUDE.md')));
  g('commit', '--allow-empty', '-m', 'engine update', '--quiet');
  recall();
  t('new engine revision: recall re-renders', existsSync(join(home5, '.claude', 'CLAUDE.md')));
}

// 21. Invariants: no services, no LLM APIs anywhere in engine code
{
  const forbidden = ['api.openai.com', 'api.anthropic.com', 'convex', 'workos', 'createServer', '.listen('];
  let clean = true;
  for (const dir of ['bin', 'hooks']) {
    for (const f of readdirSync(join(repo, dir))) {
      const src = read(join(repo, dir, f)).toLowerCase();
      if (forbidden.some((p) => src.includes(p))) clean = false;
    }
  }
  t('engine code is service- and LLM-free', clean);
}

rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall tests passed');
process.exit(failures ? 1 : 0);
