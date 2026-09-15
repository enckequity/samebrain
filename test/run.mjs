#!/usr/bin/env node
// Self-contained test suite — no framework, no deps. Copies the repo to a temp dir,
// points HOME/USERPROFILE at a fake home, and exercises render + hooks end-to-end.
//   node test/run.mjs        exit 0 = all pass
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmodSync, constants as fsConstants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// 1. Fresh render writes every target (Gemini/Copilot/OpenClaw detected via their dirs)
{
  mkdirSync(at('.gemini'), { recursive: true });
  mkdirSync(at('.copilot'), { recursive: true });
  mkdirSync(at('.openclaw', 'workspace'), { recursive: true });
  mkdirSync(at('.config', 'opencode'), { recursive: true });
  writeFileSync(at('.openclaw', 'workspace', 'AGENTS.md'), '# OpenClaw local guidance\n\nKeep this.\n');
  writeFileSync(at('.openclaw', 'openclaw.json'), JSON.stringify({ agents: { defaults: { model: 'keep/model' } } }));
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
  const openclawAgents = read(at('.openclaw', 'workspace', 'AGENTS.md'));
  t('openclaw gets a managed instruction block', openclawAgents.includes('samebrain:managed:start')
    && openclawAgents.includes('OpenClaw conventions'));
  t('openclaw local instructions survive', openclawAgents.includes('# OpenClaw local guidance')
    && openclawAgents.includes('Keep this.'));
  const openclawConfig = JSON.parse(read(at('.openclaw', 'openclaw.json')));
  t('openclaw model config survives', openclawConfig.agents.defaults.model === 'keep/model');
  t('openclaw discovers rendered shared skills', openclawConfig.skills.load.extraDirs.includes(at('.claude', 'skills')));
  t('writes opencode agent', existsSync(at('.config', 'opencode', 'agent', 'autonomous.md')));
  const ocAgent = read(at('.config', 'opencode', 'agent', 'autonomous.md'));
  t('opencode agent carries the generated marker', ocAgent.includes('edit global/agents/opencode/autonomous.md in the repo, not here'));
  t('opencode agent keeps frontmatter, no unresolved token', ocAgent.startsWith('---\n') && !ocAgent.includes('{{REPO}}'));
}

// 1b. opencode plugins (guardrails/notify/telemetry) and the workflow skills render
// and their hooks enforce policy, driven through the plugin contract directly.
{
  const pluginDir = at('.config', 'opencode', 'plugins');
  const guardrailsPath = join(pluginDir, 'guardrails.js');
  const notifyPath = join(pluginDir, 'notify.js');
  const telemetryPath = join(pluginDir, 'telemetry.js');
  t('renders guardrails plugin', existsSync(guardrailsPath));
  t('renders notify plugin', existsSync(notifyPath));
  t('renders telemetry plugin', existsSync(telemetryPath));
  t('plugins are marker-stamped', read(guardrailsPath).includes('rendered by samebrain'));
  t('telemetry resolves {{REPO}} to the repo', !read(telemetryPath).includes('{{REPO}}')
    && read(telemetryPath).includes(repo.replaceAll('\\', '/')));
  t('renders pr-workflow skill', existsSync(at('.claude', 'skills', 'pr-workflow', 'SKILL.md')));
  t('renders security-review skill', existsSync(at('.claude', 'skills', 'security-review', 'SKILL.md')));

  const { default: guardrails } = await import(pathToFileURL(guardrailsPath).href);
  const gh = await guardrails({ directory: repo });
  const blocked = async (cmd) => {
    try { await gh['tool.execute.before']({ tool: 'bash' }, { args: { command: cmd } }); return false }
    catch { return true }
  };
  t('guardrails blocks non-conventional commit', await blocked('git commit -m "added stuff"'));
  t('guardrails blocks AI attribution', await blocked('git commit -m "feat: x" -m "Co-authored-by: Claude"'));
  t('guardrails blocks force-push', await blocked('git push --force'));
  t('guardrails blocks secret staging', await blocked('git add .env'));
  t('guardrails allows a conventional commit', !(await blocked('git commit -m "feat: add thing"')));
  t('guardrails allows a read-only gh call', !(await blocked('gh pr list')));
  let nonBash = true;
  try { await gh['tool.execute.before']({ tool: 'read' }, { args: { command: 'git add .env' } }) }
  catch { nonBash = false }
  t('guardrails ignores non-bash tools', nonBash);

  const notifyLog = join(work, 'notify.log');
  process.env.OPENCODE_NOTIFY_LOG = notifyLog;
  process.env.OPENCODE_NOTIFY_MIN_MS = '0';
  const { default: notify } = await import(pathToFileURL(notifyPath).href);
  delete process.env.OPENCODE_NOTIFY_LOG;
  delete process.env.OPENCODE_NOTIFY_MIN_MS;
  const nh = await notify({ directory: join(repo, 'work') });
  await nh.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
  t('notify fires once on idle', existsSync(notifyLog) && read(notifyLog).includes('opencode task done in work'));

  process.env.SAMEBRAIN_DIR = repo;
  const { default: telemetry } = await import(pathToFileURL(telemetryPath).href);
  delete process.env.SAMEBRAIN_DIR;
  const th = await telemetry({ directory: repo });
  await th.event({ event: { type: 'message.updated', properties: { info: {
    id: 'm1', sessionID: 's1', role: 'assistant', cost: 0.5, modelID: 'provider/test',
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  } } } });
  await th.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });
  const costs = join(repo, 'telemetry', hostname().split('.')[0], 'opencode-costs.jsonl');
  const costLine = existsSync(costs) ? read(costs) : '';
  t('telemetry records session cost', costLine.includes('"cost_usd":0.5') && costLine.includes('"output":5'));
}

// 1c. opencode auto-continue plugin, driven through a fake client
{
  const pluginPath = at('.config', 'opencode', 'plugins', 'auto-continue.js');
  t('renders auto-continue plugin', existsSync(pluginPath) && !read(pluginPath).includes('{{REPO}}'));
  const { default: autoContinue } = await import(pathToFileURL(pluginPath).href);
  const sent = [];
  let reply = 'Should I keep going?';
  let parentID;
  const client = {
    session: {
      get: async () => ({ data: { parentID } }),
      messages: async () => ({ data: [{ info: { role: 'user' }, parts: [] }, { info: { role: 'assistant' }, parts: [{ type: 'text', text: reply }] }] }),
      promptAsync: async ({ path, body }) => { sent.push({ id: path.id, text: body.parts[0].text }); return {}; },
    },
    app: { log: async () => {} },
  };
  const saved = { ...process.env };
  const idle = (h, id = 's1') => h.event({ event: { type: 'session.idle', properties: { sessionID: id } } });
  process.env.AGENTDECK_INSTANCE_ID = '';
  process.env.AGENTDECK_IDENTITY_FILE = '';
  process.env.AUTO_CONTINUE = '';
  t('plugin is inert outside autonomous sessions', Object.keys(await autoContinue({ client })).length === 0);
  process.env.AUTO_CONTINUE = '1';
  process.env.AUTO_CONTINUE_MAX = '2';
  const h = await autoContinue({ client });
  const sys = { system: [] };
  await h['experimental.chat.system.transform']({ sessionID: 's1' }, sys);
  t('plugin injects the contract', sys.system.some((x) => x.includes('===AGENTDECK_DONE===')));
  let questionBlocked = false;
  try { await h['tool.execute.before']({ tool: 'question', sessionID: 's1' }, { args: {} }); } catch { questionBlocked = true; }
  t('plugin denies the question tool', questionBlocked);
  t('plugin leaves other tools alone', await h['tool.execute.before']({ tool: 'bash', sessionID: 's1' }, { args: {} }).then(() => true, () => false));
  await idle(h);
  t('idle without marker sends a nudge', sent.length === 1 && sent[0].text.includes('(1/2)'));
  await h['chat.message']({ sessionID: 's1' });
  await idle(h);
  t('own nudge does not reset the budget', sent.length === 2 && sent[1].text.includes('(2/2)'));
  await h['chat.message']({ sessionID: 's1' });
  await idle(h);
  t('plugin stops at the budget', sent.length === 2);
  await h['chat.message']({ sessionID: 's1' });
  await idle(h);
  t('human prompt resets the plugin budget', sent.length === 3 && sent[2].text.includes('(1/2)'));
  await h.event({ event: { type: 'session.error', properties: { sessionID: 's1', error: { name: 'MessageAbortedError' } } } });
  await idle(h);
  t('user abort is not nudged', sent.length === 3);
  const failing = await autoContinue({ client: { ...client, session: { ...client.session, promptAsync: async () => { sent.push({ id: 'f', text: 'x' }); return {}; } } } });
  await idle(failing, 'f1');
  await idle(failing, 'f1');
  t('a nudge that never started is not stacked', sent.filter((x) => x.id === 'f').length === 1);
  sent.splice(sent.findIndex((x) => x.id === 'f'), 1);
  process.env.AUTO_CONTINUE_MAX = '2';
  reply = 'Done.\n===AGENTDECK_DONE===';
  await idle(h);
  t('terminal marker is not nudged', sent.length === 3);
  reply = 'halfway';
  parentID = 'root';
  await idle(h, 'child');
  t('subagent sessions are not nudged', sent.length === 3);
  for (const k of ['AGENTDECK_INSTANCE_ID', 'AGENTDECK_IDENTITY_FILE', 'AUTO_CONTINUE', 'AUTO_CONTINUE_MAX']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

// 2. Idempotence
{
  const r = render();
  t('second render is a no-op', r.stdout.includes('everything in sync'));
  const agents = read(at('.openclaw', 'workspace', 'AGENTS.md'));
  t('openclaw managed block is not duplicated', agents.split('samebrain:managed:start').length === 2);
  writeFileSync(at('.openclaw', 'workspace', 'AGENTS.md'), agents.replace('<!-- samebrain:managed:end -->', ''));
  const malformed = render();
  t('openclaw malformed managed block fails closed', malformed.status === 1
    && malformed.stderr.includes('malformed managed block markers'));
  writeFileSync(at('.openclaw', 'workspace', 'AGENTS.md'), agents);
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
  t('stop_hook_active does not bypass the check', stop({ session_id: 's1', stop_hook_active: true }).status === 2);
  stop({ session_id: 's1' }); // third block
  t('consecutive blocks are capped at 3', stop({ session_id: 's1' }).status === 0);
  rmSync(join(sl, '.stop-blocks'), { recursive: true, force: true });
  t('no state dir is silent', spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-stop.mjs')], {
    env: { ...env, SMARTLOOP_DIR: join(work, 'absent') }, input: '{"session_id":"s1"}', encoding: 'utf8',
  }).status === 0);
  t('garbage stdin is silent', spawnSync(process.execPath, [join(repo, 'hooks', 'smartloop-stop.mjs')], {
    env: { ...env, SMARTLOOP_DIR: sl }, input: 'not json', encoding: 'utf8',
  }).status === 0);
}

// 11b. auto-continue: Stop hook nudges autonomous sessions until a terminal marker
{
  const hook = join(repo, 'hooks', 'auto-continue.mjs');
  const stateDir = join(work, 'auto-continue');
  const transcript = join(work, 'ac-transcript.jsonl');
  const say = (text) => writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
  ].join('\n'));
  const run = (extraEnv, payload, flag) => spawnSync(process.execPath, flag ? [hook, flag] : [hook], {
    env: { ...env, AGENTDECK_INSTANCE_ID: '', AGENTDECK_IDENTITY_FILE: '', AUTO_CONTINUE: '', CLAUDE_CODE_ENTRYPOINT: '', AUTO_CONTINUE_STATE_DIR: stateDir, ...extraEnv },
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8',
  });
  const on = { AGENTDECK_INSTANCE_ID: 'deck-1', AUTO_CONTINUE_MAX: '2' };
  const payload = { session_id: 'ac1', transcript_path: transcript };
  say('Want me to open the PR next?');
  t('auto-continue silent outside autonomous sessions', run({}, payload).stdout === '');
  t('AUTO_CONTINUE=0 beats agent-deck', run({ ...on, AUTO_CONTINUE: '0' }, payload).stdout === '');
  t('agent-deck identity file alone enables', JSON.parse(run({ AGENTDECK_IDENTITY_FILE: '/x/identity.md', AUTO_CONTINUE_STATE_DIR: join(work, 'ac-id') }, { session_id: 'ac9', last_assistant_message: 'x' }).stdout || '{}').decision === 'block');
  const r1 = run(on, payload);
  const d1 = JSON.parse(r1.stdout || '{}');
  t('agent-deck session without marker is blocked', r1.status === 0 && d1.decision === 'block' && d1.reason.includes('(1/2)'));
  t('AUTO_CONTINUE=1 enables outside agent-deck', JSON.parse(run({ AUTO_CONTINUE: '1', AUTO_CONTINUE_MAX: '2' }, payload).stdout || '{}').reason?.includes('(2/2)'));
  t('nudges stop at the budget', run(on, payload).stdout === '');
  run(on, payload, '--prompt');
  t('human prompt resets the budget', JSON.parse(run(on, payload).stdout || '{}').reason?.includes('(1/2)'));
  for (const marker of ['All green.\n===AGENTDECK_DONE===', 'BLOCKED: needs prod deploy approval', 'WAITING: CI run']) {
    say(marker);
    t(`terminal marker allows stop: ${marker.split(/[\n:]/)[0]}`, run(on, payload).stdout === '');
  }
  t('marker inline mid-line is not BLOCKED', (say('I am not BLOCKED: really'), run(on, payload).stdout.includes('block')));
  t('quoted marker mid-message is not terminal', run(on, { session_id: 'ac4', last_assistant_message: 'I will end with ===AGENTDECK_DONE=== later.\nNext: tests' }).stdout.includes('block'));
  t('headless claude -p never auto-continues', run({ ...on, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, { session_id: 'ac5', last_assistant_message: 'x' }).stdout === '');
  t('background tasks let the session rest', run(on, { session_id: 'ac6', last_assistant_message: 'x', background_tasks: [{ id: 'b1' }] }).stdout === '');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'old turn\n===AGENTDECK_DONE===' }] } }),
    JSON.stringify({ type: 'user', message: { content: 'next task' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
  ].join('\n'));
  t('previous turn marker does not end this turn', run(on, { session_id: 'ac7', transcript_path: transcript }).stdout.includes('block'));
  t('last_assistant_message preferred over transcript', run(on, { session_id: 'ac2', last_assistant_message: '===AGENTDECK_DONE===' }).stdout === '');
  const deny = JSON.parse(run(on, { session_id: 'ac8', tool_name: 'AskUserQuestion' }, '--pre-tool').stdout || '{}');
  t('AskUserQuestion is denied in autonomous sessions', deny.hookSpecificOutput?.permissionDecision === 'deny');
  t('other tools pass the pre-tool hook', run(on, { session_id: 'ac8', tool_name: 'Bash' }, '--pre-tool').stdout === '');
  t('AskUserQuestion allowed outside autonomous sessions', run({}, { session_id: 'ac8', tool_name: 'AskUserQuestion' }, '--pre-tool').stdout === '');
  const ss = JSON.parse(run(on, payload, '--session-start').stdout || '{}');
  t('session start injects the contract', ss.hookSpecificOutput?.additionalContext?.includes('===AGENTDECK_DONE==='));
  t('garbage stdin is silent', run(on, 'not json').stdout === '' && run(on, 'not json').status === 0);
  t('missing transcript is silent', run(on, { session_id: 'ac3', transcript_path: join(work, 'absent.jsonl') }).stdout === '');
  t('session id cannot escape the state dir', run(on, { session_id: '../../evil', last_assistant_message: 'x' }).status === 0
    && !existsSync(join(work, 'evil.json')));
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
  for (const [event, flag] of [['SessionStart', '--session-start'], ['UserPromptSubmit', '--prompt'], ['Stop', ''], ['PreToolUse', '--pre-tool']]) {
    t(`auto-continue ${event} registered once`, (settings.hooks[event] ?? []).flatMap((e) => e.hooks ?? [])
      .filter((h) => h.command.includes('auto-continue.mjs') && (flag ? h.command.endsWith(flag) : h.command.endsWith('.mjs"'))).length === 1);
  }
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

// 16c. sync.mjs commits coordination/leases so a claim taken here crosses machines
{
  const box = join(work, 'sync-git');
  mkdirSync(join(box, 'hooks'), { recursive: true });
  cpSync(join(repo, 'hooks', 'sync.mjs'), join(box, 'hooks', 'sync.mjs'));
  mkdirSync(join(box, 'coordination', 'leases'), { recursive: true });
  const g = (...args) => execFileSync('git', args, { cwd: box, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  g('init'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  g('add', '-A'); g('commit', '-m', 'init', '--quiet');
  writeFileSync(join(box, 'coordination', 'leases', 'claim.lease'),
    JSON.stringify({ owner: 'claude@boxa', expires: '2099-01-01T00:00:00Z' }));
  const r = spawnSync(process.execPath, [join(box, 'hooks', 'sync.mjs'), '--agent', 'claude'], {
    env, input: '{}', encoding: 'utf8',
  });
  t('sync exits 0 in a git repo with no remote', r.status === 0);
  t('sync commits the new lease', g('ls-files', 'coordination/leases').includes('claim.lease'));
  t('sync records a session commit', g('log', '--oneline').includes('session update'));
  t('sync leaves no uncommitted lease', g('status', '--porcelain', 'coordination') === '');
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

// 17b. Lease hygiene: warn on dead leases, --gc prunes expired + malformed ones
{
  const ld = join(repo, 'coordination', 'leases');
  mkdirSync(ld, { recursive: true });
  writeFileSync(join(ld, 'old.lease'), JSON.stringify({ owner: 'a@b', expires: '2020-01-01T00:00:00Z' }));
  writeFileSync(join(ld, 'live.lease'), JSON.stringify({ owner: 'c@d', expires: '2099-01-01T00:00:00Z' }));
  writeFileSync(join(ld, 'broken.lease'), 'not json');
  const r1 = render({ SB_FILE_TOKEN: 'x' });
  t('plain render warns on prunable leases', r1.stdout.includes('expired lease'));
  t('plain render spares dead leases', existsSync(join(ld, 'old.lease')));
  const r2 = spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs'), '--gc'], {
    env: { ...env, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  t('--gc prunes the expired lease', r2.status === 0 && !existsSync(join(ld, 'old.lease')));
  t('--gc prunes the malformed lease', !existsSync(join(ld, 'broken.lease')));
  t('--gc spares the live lease', existsSync(join(ld, 'live.lease')));
  rmSync(ld, { recursive: true });
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

// 18b. retiredMcpServers are deleted from ~/.claude.json; unmanaged servers survive
{
  writeFileSync(join(repo, 'global', 'mcp.json'), JSON.stringify({
    retiredMcpServers: ['oldtool'],
    mcpServers: { mytool: { targets: ['codex'], command: 'npx', args: ['-y', 'mytool-mcp'], env: { KEY: '${SB_FILE_TOKEN}' } } },
  }));
  const claudeJson = JSON.parse(existsSync(at('.claude.json')) ? read(at('.claude.json')) : '{}');
  writeFileSync(at('.claude.json'), JSON.stringify({
    ...claudeJson, mcpServers: { ...(claudeJson.mcpServers ?? {}), oldtool: { command: 'old' }, mine: { command: 'keep-me' } },
  }));
  t('retired render exits 0', render({ SB_FILE_TOKEN: 'tok456' }).status === 0);
  const servers = JSON.parse(read(at('.claude.json'))).mcpServers;
  t('retired claude mcp server removed', !('oldtool' in servers));
  t('unmanaged claude mcp server kept', servers.mine?.command === 'keep-me');
  t('retired removal idempotent', !render({ SB_FILE_TOKEN: 'tok456' }).stdout.includes('.claude.json'));
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
  const ocPlugin = join(home4, '.config', 'opencode', 'plugins', 'samebrain-memory.ts');
  t('opencode gets the memory plugin', existsSync(ocPlugin));
  t('opencode plugin is marker-stamped', read(ocPlugin).includes('rendered by samebrain'));
  t('opencode plugin resolves {{REPO}} to the repo', !read(ocPlugin).includes('{{REPO}}')
    && read(ocPlugin).includes(repo.replaceAll('\\', '/')));
  const ocPkg = JSON.parse(read(join(home4, '.config', 'opencode', 'package.json')));
  t('opencode package.json declares @opencode-ai/plugin', Boolean(ocPkg.dependencies?.['@opencode-ai/plugin']));
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

// 36. Kimi Code: global instructions and opt-in skill rendering
{
  const home6 = join(work, 'home6');
  mkdirSync(join(home6, '.kimi-code'), { recursive: true });
  const r = spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs')], {
    env: { ...process.env, HOME: home6, USERPROFILE: home6, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  t('kimi render exits 0', r.status === 0);
  t('kimi gets AGENTS.md', existsSync(join(home6, '.kimi-code', 'AGENTS.md')));
  const kimiMd = read(join(home6, '.kimi-code', 'AGENTS.md'));
  t('kimi AGENTS.md carries render marker', kimiMd.includes('rendered by samebrain'));
  t('kimi AGENTS.md carries memory bootstrap', kimiMd.includes('Memory bootstrap'));
  t('kimi AGENTS.md substitutes repo path', !kimiMd.includes('{{REPO}}') && kimiMd.includes(repo.replaceAll('\\', '/')));
  const r2 = spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs')], {
    env: { ...process.env, HOME: home6, USERPROFILE: home6, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  t('kimi render idempotent', r2.stdout.includes('everything in sync'));

  // Opt-in skill target
  mkdirSync(join(repo, 'skills', 'kimiskill'), { recursive: true });
  writeFileSync(join(repo, 'skills', 'kimiskill', 'SKILL.md'), '---\nname: kimiskill\ndescription: x\ntargets: kimi\n---\nbody\n');
  const r3 = spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs')], {
    env: { ...process.env, HOME: home6, USERPROFILE: home6, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  t('kimi-target skill renders to ~/.agents/skills', existsSync(join(home6, '.agents', 'skills', 'kimiskill', 'SKILL.md')));
  t('kimi-target skill carries marker', read(join(home6, '.agents', 'skills', 'kimiskill', 'SKILL.md')).includes('rendered by samebrain'));
  t('kimi-target skill omits {{REPO}}', !read(join(home6, '.agents', 'skills', 'kimiskill', 'SKILL.md')).includes('{{REPO}}'));

  // Absence = no files, no error
  const home7 = join(work, 'home7');
  mkdirSync(home7, { recursive: true });
  const r4 = spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs')], {
    env: { ...process.env, HOME: home7, USERPROFILE: home7, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  t('kimi skipped when absent', r4.status === 0 && !existsSync(join(home7, '.kimi-code', 'AGENTS.md')));
}

// 36b. Skill resources follow native skills; shared discovery avoids Codex/Kimi duplicates
{
  const skillDir = join(repo, 'skills', 'resource-skill');
  mkdirSync(join(skillDir, 'references'), { recursive: true });
  mkdirSync(join(skillDir, 'scripts', 'nested'), { recursive: true });
  mkdirSync(join(skillDir, 'assets'), { recursive: true });
  mkdirSync(join(skillDir, 'agents'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), [
    '---',
    'name: resource-skill',
    'description: resource fixture',
    'targets: claude, cursor, codex, codex-skill, kimi',
    '---',
    'Read `references/guide.md`, run `scripts/nested/run.sh`, and inspect `assets/blob.bin`.',
    '',
  ].join('\n'));
  writeFileSync(join(skillDir, 'references', 'guide.md'), 'guide-v1\n');
  writeFileSync(join(skillDir, 'scripts', 'nested', 'run.sh'), '#!/bin/sh\necho fixture\n');
  const blob = Buffer.from([0, 255, 1, 2, 128]);
  writeFileSync(join(skillDir, 'assets', 'blob.bin'), blob);
  const agentPolicy = Buffer.from('policy:\n  allow_implicit_invocation: false\n');
  const agentPolicySource = join(skillDir, 'agents', 'openai.yaml');
  writeFileSync(agentPolicySource, agentPolicy);
  chmodSync(agentPolicySource, 0o640);
  const agentPolicyMode = statSync(agentPolicySource).mode & 0o777;

  const first = render({ SB_FILE_TOKEN: 'x' });
  t('resource skill render exits 0', first.status === 0);
  for (const parts of [
    ['.claude', 'skills', 'resource-skill'],
    ['.cursor', 'skills', 'resource-skill'],
    ['.agents', 'skills', 'resource-skill'],
  ]) {
    const target = at(...parts);
    const guide = join(target, 'references', 'guide.md');
    const script = join(target, 'scripts', 'nested', 'run.sh');
    const asset = join(target, 'assets', 'blob.bin');
    const metadata = join(target, 'agents', 'openai.yaml');
    t(`${parts[0]} gets reference bytes`, existsSync(guide) && read(guide) === 'guide-v1\n');
    t(`${parts[0]} gets nested scripts`, existsSync(script) && read(script).includes('echo fixture'));
    t(`${parts[0]} gets binary assets`, existsSync(asset) && readFileSync(asset).equals(blob));
    t(`${parts[0]} gets agent metadata bytes and mode`, existsSync(metadata)
      && readFileSync(metadata).equals(agentPolicy) && (statSync(metadata).mode & 0o777) === agentPolicyMode);
  }
  t('Codex and Kimi share one native skill copy', !existsSync(at('.codex', 'skills', 'resource-skill', 'SKILL.md')));
  const prompt = read(at('.codex', 'prompts', 'resource-skill.md'));
  t('flat Codex prompt resolves relative resource paths to the canonical skill',
    prompt.includes(join(repo, 'skills', 'resource-skill', 'references', 'guide.md').replaceAll('\\', '/'))
      && prompt.includes(join(repo, 'skills', 'resource-skill', 'scripts', 'nested', 'run.sh').replaceAll('\\', '/')));

  const sharedSkill = at('.agents', 'skills', 'resource-skill', 'SKILL.md');
  const staleCodexSkill = at('.codex', 'skills', 'resource-skill', 'SKILL.md');
  mkdirSync(dirname(staleCodexSkill), { recursive: true });
  const oldCanonical = existsSync(sharedSkill) ? read(sharedSkill) : read(at('.codex', 'skills', 'resource-skill', 'SKILL.md'));
  writeFileSync(staleCodexSkill, oldCanonical);
  writeFileSync(join(dirname(staleCodexSkill), 'local-notes.md'), 'keep me\n');
  writeFileSync(join(skillDir, 'SKILL.md'), read(join(skillDir, 'SKILL.md')).replace('resource fixture', 'updated fixture'));
  writeFileSync(join(skillDir, 'references', 'guide.md'), 'guide-v2\n');

  const check = spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs'), '--check'], {
    env: { ...env, SB_FILE_TOKEN: 'x' }, encoding: 'utf8',
  });
  const sharedGuide = at('.agents', 'skills', 'resource-skill', 'references', 'guide.md');
  t('--check reports skill/resource drift', check.status === 0 && check.stdout.includes('drift'));
  t('--check does not update resource bytes', !existsSync(sharedGuide) || read(sharedGuide) === 'guide-v1\n');
  t('--check does not remove stale native copies', existsSync(staleCodexSkill));

  const update = render({ SB_FILE_TOKEN: 'x' });
  t('resource drift updates on apply', update.status === 0
    && existsSync(sharedGuide) && read(sharedGuide) === 'guide-v2\n');
  t('safe stale Codex copy is removed', !existsSync(staleCodexSkill));
  t('stale-copy cleanup preserves siblings', read(join(dirname(staleCodexSkill), 'local-notes.md')) === 'keep me\n');
  t('stale-copy cleanup creates a backup', readdirSync(join(repo, 'backups')).some((f) => f.includes('resource-skill_SKILL.md')));
  t('skill/resource render is idempotent', render({ SB_FILE_TOKEN: 'x' }).stdout.includes('everything in sync'));

  writeFileSync(staleCodexSkill, oldCanonical.replace('resource fixture', 'locally modified'));
  render({ SB_FILE_TOKEN: 'x' });
  t('locally modified stale Codex copy is preserved', existsSync(staleCodexSkill));
  writeFileSync(staleCodexSkill, 'unmanaged local skill\n');
  render({ SB_FILE_TOKEN: 'x' });
  t('unmanaged Codex skill is preserved', read(staleCodexSkill) === 'unmanaged local skill\n');

  const kimiOnly = join(repo, 'skills', 'kimi-resource');
  mkdirSync(join(kimiOnly, 'references'), { recursive: true });
  writeFileSync(join(kimiOnly, 'SKILL.md'), '---\nname: kimi-resource\ndescription: x\ntargets: kimi\n---\nbody\n');
  writeFileSync(join(kimiOnly, 'references', 'only.md'), 'kimi only\n');
  render({ SB_FILE_TOKEN: 'x' });
  t('resource target exclusions match the skill target',
    existsSync(at('.agents', 'skills', 'kimi-resource', 'references', 'only.md'))
      && !existsSync(at('.claude', 'skills', 'kimi-resource'))
      && !existsSync(at('.cursor', 'skills', 'kimi-resource'))
      && !existsSync(at('.codex', 'prompts', 'kimi-resource.md')));

  const codexOnly = join(repo, 'skills', 'codex-resource');
  mkdirSync(join(codexOnly, 'references'), { recursive: true });
  writeFileSync(join(codexOnly, 'SKILL.md'), '---\nname: codex-resource\ndescription: x\ntargets: codex-skill\n---\nbody\n');
  writeFileSync(join(codexOnly, 'references', 'only.md'), 'codex only\n');
  render({ SB_FILE_TOKEN: 'x' });
  t('Codex-only native skill keeps its private target and resources',
    existsSync(at('.codex', 'skills', 'codex-resource', 'references', 'only.md'))
      && !existsSync(at('.agents', 'skills', 'codex-resource')));

  const failureDir = join(repo, 'skills', 'resource-failure');
  mkdirSync(join(failureDir, 'references'), { recursive: true });
  writeFileSync(join(failureDir, 'SKILL.md'),
    '---\nname: resource-failure\ndescription: x\ntargets: codex-skill, kimi\n---\nRead `references/guide.md`.\n');
  writeFileSync(join(failureDir, 'references', 'guide.md'), 'required resource\n');
  render({ SB_FILE_TOKEN: 'x' });
  const failureSharedDir = at('.agents', 'skills', 'resource-failure');
  const failureLegacy = at('.codex', 'skills', 'resource-failure', 'SKILL.md');
  mkdirSync(dirname(failureLegacy), { recursive: true });
  writeFileSync(failureLegacy, read(join(failureSharedDir, 'SKILL.md')));
  rmSync(failureSharedDir, { recursive: true });
  mkdirSync(join(failureSharedDir, 'references', 'guide.md'), { recursive: true });
  const failedPublish = render({ SB_FILE_TOKEN: 'x' });
  t('failed shared resource publish keeps the legacy Codex entrypoint',
    failedPublish.status !== 0 && existsSync(failureLegacy));
  rmSync(join(failureSharedDir, 'references', 'guide.md'), { recursive: true });
  const recoveredPublish = render({ SB_FILE_TOKEN: 'x' });
  t('successful shared retry removes the redundant legacy entrypoint',
    recoveredPublish.status === 0 && !existsSync(failureLegacy)
      && read(join(failureSharedDir, 'references', 'guide.md')) === 'required resource\n');
}

// 37. Hindsight (opt-in): fake server, gated render, recall/search/backfill against it
{
  // Async spawn: the fake server shares this event loop, so spawnSync would deadlock it.
  const runAsync = (script, args, opts = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: opts.env, cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    const started = Date.now();
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(opts.input ?? '');
  });

  const calls = [];
  const banks = new Map(); // bank -> { docs: Map }
  // Models the server's tenant-level memory_defense: stored content is redacted unless `leaky`.
  const tenant = { leaky: false };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      const m = req.url.match(/^\/v1\/default\/banks\/([^/]+)(\/.*)?$/);
      if (req.headers.authorization !== 'Bearer test-dev-key') return send(401, { detail: 'Authentication failed' });
      if (!m) return send(404, {});
      const bank = decodeURIComponent(m[1]);
      const rest = m[2] ?? '';
      if (rest === '/memories/recall') {
        if (bank === 'slow-bank') return setTimeout(() => send(200, { results: [{ text: 'slow fact for slow-bank', type: 'observation' }] }), 6000);
        return send(200, { results: [{ text: `remembered fact for ${bank}`, type: 'observation', mentioned_at: '2026-09-01T00:00:00Z' }] });
      }
      const b = banks.get(bank);
      const setupStore = (key) => { if (!banks.has(bank)) banks.set(bank, { docs: new Map() }); const x = banks.get(bank); x[key] ??= []; return x[key]; };
      if (rest.startsWith('/knowledge-base/tree')) {
        return send(200, { roots: (b?.pages ?? []).map((pg) => ({ id: pg.id, kind: 'page', name: pg.name, description: pg.source_query, tags: pg.tags, trigger: pg.trigger, mental_model_id: `mm-${pg.id}`, children: [] })) });
      }
      if (rest.startsWith('/knowledge-base/pages/') && req.method === 'GET') {
        const pg = (b?.pages ?? []).find((x) => x.id === decodeURIComponent(rest.split('/')[3]));
        return pg ? send(200, { id: pg.id, name: pg.name, body: pg.body ?? '', markdown: '' }) : send(404, {});
      }
      if (rest === '/knowledge-base/pages' && req.method === 'POST') {
        const list = setupStore('pages');
        list.push({ id: `p${list.length}`, ...body, body: `page body for ${body.name} in ${bank}` });
        return send(201, { page_id: `p${list.length - 1}`, operation_id: 'op-page' });
      }
      if (rest.startsWith('/knowledge-base/nodes/') && req.method === 'PATCH') {
        Object.assign((b?.pages ?? []).find((x) => x.id === decodeURIComponent(rest.split('/')[3])), body);
        return send(200, {});
      }
      if (rest.startsWith('/mental-models') || rest.startsWith('/directives')) {
        const key = rest.startsWith('/mental-models') ? 'models' : 'directives';
        const list = setupStore(key);
        const id = decodeURIComponent(rest.split('?')[0].split('/')[2] ?? '');
        if (req.method === 'GET') return send(200, { items: list, total: list.length, limit: 100, offset: 0 });
        if (req.method === 'POST') { list.push({ id: body.id ?? `d${list.length}`, ...body }); return send(200, { operation_id: 'op-mm' }); }
        if (req.method === 'PATCH') { Object.assign(list.find((x) => x.id === id), body); return send(200, {}); }
      }
      if (req.method === 'DELETE' && rest === '') {
        banks.delete(bank);
        return send(200, { success: true });
      }
      if (rest.startsWith('/operations/')) return send(200, { operation_id: rest.slice(12), status: 'completed' });
      if (rest.startsWith('/memories/list')) {
        return send(200, { items: [...(b?.docs.values() ?? [])].map((d) => ({ text: d.content.slice(0, 200) })) });
      }
      const chunks = rest.match(/^\/documents\/(.+)\/chunks$/);
      if (chunks) {
        const found = b?.docs.get(decodeURIComponent(chunks[1]));
        return found ? send(200, { items: [{ chunk_text: found.content }] }) : send(404, { detail: 'Document not found' });
      }
      const doc = rest.match(/^\/documents\/(.+)$/);
      if (doc) {
        const found = b?.docs.get(decodeURIComponent(doc[1]));
        return found
          ? send(200, { id: found.document_id, original_text: found.content, document_metadata: found.metadata })
          : send(404, { detail: 'Document not found' });
      }
      if (req.method === 'POST' && rest === '/memories') {
        if (!b) banks.set(bank, { docs: new Map() });
        for (const item of body.items) {
          const content = tenant.leaky ? item.content : item.content.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED:anthropic_key]');
          banks.get(bank).docs.set(item.document_id, { ...item, content });
        }
        return send(200, { success: true, async: true, operation_id: `op-${calls.length}` });
      }
      return send(404, {});
    });
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const url = `http://127.0.0.1:${server.address().port}`;

  const hsHome = join(work, 'home-hindsight');
  mkdirSync(join(hsHome, '.config', 'opencode'), { recursive: true });
  const hsEnv = (extra = {}) => ({ ...process.env, HOME: hsHome, USERPROFILE: hsHome, SB_FILE_TOKEN: 'x', SAMEBRAIN_HINDSIGHT_MAINTAIN: '0', ...extra });
  const keys = { HINDSIGHT_API_URL: url, HINDSIGHT_API_KEY: 'test-dev-key' };
  const renderHs = (extra) => spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs')], { env: hsEnv(extra), encoding: 'utf8' });
  const hsDir = join(hsHome, '.hindsight');
  const settingsFile = join(hsHome, '.claude', 'settings.json');

  // Gate closed by default: keys alone do not enable the backend (the shipped config is enabled: false).
  const hsConfigFile = join(repo, 'global', 'hindsight.json');
  const shipped = JSON.parse(read(hsConfigFile));
  t('hindsight: shipped config is off by default', shipped.enabled === false);
  const disabled = renderHs({ HINDSIGHT_API_URL: url, HINDSIGHT_API_KEY: 'test-dev-key' });
  t('hindsight: keys without enabled → no ~/.hindsight config', disabled.status === 0 && !existsSync(join(hsDir, 'coding-agent.json'))
    && !read(join(hsHome, '.claude', 'CLAUDE.md')).includes('Long-term memory (Hindsight)'));
  const disabledRecall = spawnSync(process.execPath, [join(repo, 'hooks', 'recall.mjs')], {
    env: hsEnv({ HINDSIGHT_API_URL: url, HINDSIGHT_API_KEY: 'test-dev-key' }), encoding: 'utf8', input: '{}',
  });
  t('hindsight: disabled recall injects only the markdown index', disabledRecall.status === 0
    && disabledRecall.stdout.includes('<shared-agent-memory') && !disabledRecall.stdout.includes('<hindsight_memories'));
  writeFileSync(hsConfigFile, JSON.stringify({ ...shipped, enabled: true, bankSetup: { ...shipped.bankSetup, banks: ['global', 'widgets-app'] } }, null, 2));

  // Enabled, no keys → nothing Hindsight-shaped anywhere.
  const off = renderHs();
  t('hindsight: render without keys exits 0', off.status === 0);
  t('hindsight: no keys → no ~/.hindsight config', !existsSync(join(hsDir, 'coding-agent.json')));
  t('hindsight: no keys → no plugin or guide', !read(settingsFile).includes('hindsight')
    && !read(join(hsHome, '.claude', 'CLAUDE.md')).includes('Long-term memory (Hindsight)'));

  const killed = renderHs({ ...keys, SAMEBRAIN_HINDSIGHT: '0' });
  t('hindsight: SAMEBRAIN_HINDSIGHT=0 keeps render inert on this machine', killed.status === 0 && !existsSync(join(hsDir, 'coding-agent.json')));

  // Gate open, runtime not staged: config + plugin declaration, no capture hooks, activation nag.
  const pending = renderHs(keys);
  const caCfg = JSON.parse(read(join(hsDir, 'coding-agent.json')));
  t('hindsight: keys → render exits 0', pending.status === 0);
  t('hindsight: activation nag while runtime is missing', pending.stdout.includes('node bin/hindsight-activate.mjs'));
  t('hindsight: coding-agents config is self-hosted with the key', caCfg.serverMode === 'self-hosted'
    && caCfg.apiUrl === url && caCfg.apiToken === 'test-dev-key' && caCfg.bankIdTemplate === '{gitProject}');
  t('hindsight: coding-agents never runs the survey or self-updates', caCfg.codebaseSurvey === false
    && caCfg.surveyRefreshCommits === 0 && caCfg.autoUpdate === false && caCfg.gitIngest === 'message');
  t('hindsight: home-directory sessions renamed to the global bank', caCfg.banks?.[basename(hsHome)]?.bank === 'global');
  t('hindsight: config file is owner-only', process.platform === 'win32'
    || (statSync(join(hsDir, 'coding-agent.json')).mode & 0o777) === 0o600);
  t('hindsight: bank config stays server-owned', caCfg.manageBankConfig === false);
  t('hindsight: retired Claude plugin is neither declared nor configured', !existsSync(join(hsDir, 'claude-code.json'))
    && !JSON.parse(read(settingsFile)).enabledPlugins?.['hindsight-memory@hindsight'] && !JSON.parse(read(settingsFile)).extraKnownMarketplaces?.hindsight);
  t('hindsight: no capture hook before the runtime exists', !read(settingsFile).includes('claude-stop-hook.js'));
  t('hindsight: agents are told how to search', read(join(hsHome, '.claude', 'CLAUDE.md')).includes('bin/memory-search.mjs'));

  // Stage a fake runtime at the pinned version → capture hooks everywhere, idempotently.
  const pinned = JSON.parse(read(join(repo, 'global', 'hindsight.json'))).codingAgents.version;
  const runtime = join(hsDir, 'coding-agents');
  mkdirSync(join(runtime, 'dist'), { recursive: true });
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ version: pinned }));
  for (const f of ['claude-stop-hook.js', 'claude-sessionstart-hook.js', 'claude-hook.js', 'codex-stop-hook.js', 'cursor-stop-hook.js',
    'cursor-sessionstart-hook.js', 'cursor-hook.js', 'mcp-server.js']) writeFileSync(join(runtime, 'dist', f), '');
  writeFileSync(join(hsHome, '.codex', 'config.toml'), 'model = "keep"\n\n[features]\njs_repl = false\nmemories = true\nchronicle = true\n\n[memories]\nkeep = 1\n');
  const wired = renderHs(keys);
  const codexToml = read(join(hsHome, '.codex', 'config.toml'));
  t('hindsight: codex native memories switched off, rest of config.toml kept', /\[features\]\njs_repl = false\nmemories = false\nchronicle = true/.test(codexToml)
    && codexToml.includes('model = "keep"') && codexToml.includes('[memories]\nkeep = 1'));
  const claudeStop = JSON.parse(read(settingsFile)).hooks.Stop.flatMap((e) => e.hooks).find((h) => h.command.includes('claude-stop-hook.js'));
  const codexStop = JSON.parse(read(join(hsHome, '.codex', 'hooks.json'))).hooks.Stop.flatMap((e) => e.hooks).find((h) => h.command.includes('codex-stop-hook.js'));
  const cursorStop = JSON.parse(read(join(hsHome, '.cursor', 'hooks.json'))).hooks.stop.find((h) => h.command.includes('cursor-stop-hook.js'));
  t('hindsight: runtime staged → render exits 0', wired.status === 0);
  t('hindsight: claude capture hook is synchronous (headless runs drop async hooks)', claudeStop && !claudeStop.async && claudeStop.timeout === 60);
  t('hindsight: codex capture hook wired', codexStop?.timeout === 60);
  t('hindsight: cursor capture hook wired', cursorStop?.timeout === 30);
  const cursorHooks = JSON.parse(read(join(hsHome, '.cursor', 'hooks.json'))).hooks;
  t('hindsight: cursor gets session-start seeding and per-prompt injection', cursorHooks.sessionStart.some((h) => h.command.includes('cursor-sessionstart-hook.js'))
    && cursorHooks.beforeSubmitPrompt.some((h) => h.command.includes('cursor-hook.js')));
  t('hindsight: claude session start seeds through the runtime', JSON.parse(read(settingsFile)).hooks.SessionStart.flatMap((e) => e.hooks)
    .some((h) => h.command.includes('claude-sessionstart-hook.js')));
  t('hindsight: claude prompts go through the runtime hook', JSON.parse(read(settingsFile)).hooks.UserPromptSubmit.flatMap((e) => e.hooks)
    .some((h) => h.command.includes('claude-hook.js') && h.timeout === 30));
  const mcpFor = (file) => JSON.parse(read(file)).mcpServers?.hindsight;
  t('hindsight: claude and cursor get the runtime MCP server', mcpFor(join(hsHome, '.claude.json'))?.env?.HINDSIGHT_MCP_HARNESS === 'claude-code'
    && mcpFor(join(hsHome, '.cursor', 'mcp.json'))?.args?.[0]?.endsWith('mcp-server.js'));
  const caLive = JSON.parse(read(join(hsDir, 'coding-agent.json')));
  t('hindsight: survey off, pages daily, reflect once per session', caLive.codebaseSurvey === false && caLive.pageTriggerCron === 'H H * * *'
    && caLive.autoReflect === true && caLive.reflectBudget === 'mid' && caLive.harnesses.opencode.retainSessions === false);
  t('hindsight: samebrain session hooks survive', read(settingsFile).includes('sync.mjs') && read(settingsFile).includes('recall.mjs'));
  t('hindsight: opencode loads the runtime plugin', JSON.parse(read(join(hsHome, '.config', 'opencode', 'opencode.json'))).plugin.includes(runtime));
  const again = renderHs(keys);
  t('hindsight: wired render is idempotent', again.status === 0 && !again.stdout.includes('wrote:'));

  // recall.mjs: repo bank + global bank, bounded, and silent when the server is gone.
  const proj = join(work, 'hs-project');
  mkdirSync(proj, { recursive: true });
  execFileSync('git', ['init', '-q', proj]);
  writeFileSync(join(repo, 'secrets.env'), `HINDSIGHT_API_URL=${url}\nHINDSIGHT_API_KEY=test-dev-key\n`);
  calls.length = 0;
  const recalled = await runAsync(join(repo, 'hooks', 'recall.mjs'), [], { env: hsEnv(), input: JSON.stringify({ cwd: proj }) });
  t('hindsight: recall injects the repo bank', recalled.status === 0
    && recalled.stdout.includes('<hindsight_memories source="samebrain" bank="hs-project"')
    && recalled.stdout.includes('remembered fact for hs-project'));
  t('hindsight: recall also asks the global bank', recalled.stdout.includes('remembered fact for global'));
  t('hindsight: recall authenticates with the dev key and a small budget', calls.every((c) => c.auth === 'Bearer test-dev-key')
    && calls.some((c) => c.body?.budget === 'mid' && c.body?.max_tokens === 700 && c.body?.prefer_observations === true
      && JSON.stringify(c.body?.types) === '["world","experience","observation"]'));
  t('hindsight: recall keeps the shared index', recalled.stdout.includes('<shared-agent-memory'));
  const home = await runAsync(join(repo, 'hooks', 'recall.mjs'), ['--cursor'], { env: hsEnv(), input: JSON.stringify({ workspace_roots: [hsHome] }) });
  let homeCtx = '';
  try { homeCtx = JSON.parse(home.stdout).additional_context; } catch { /* asserted below */ }
  t('hindsight: home directory resolves to the global bank (cursor payload)', homeCtx.includes('bank="global"'));

  // opencode end-of-task capture: one replace-mode conversation document, scrubbed, runtime id.
  const cap = await import(pathToFileURL(join(repo, 'hooks', 'opencode-capture.mjs')).href);
  const ocMessages = [
    { info: { role: 'user', time: { created: Date.parse('2026-09-15T04:00:00Z') } }, parts: [{ type: 'text', text: 'fix the bug' }] },
    { info: { role: 'assistant', time: { created: Date.parse('2026-09-15T04:00:05Z') } }, parts: [
      { type: 'tool', tool: 'bash', state: { input: { command: 'npm test\nmore' } } },
      { type: 'text', text: 'Fixed. Key:\nsk-ant-abcdefghijklmnopqrstuvwxyz0123\nDB postgres://u:pw@host/db\n===AGENTDECK_DONE===' },
    ] },
  ];
  const ocTurns = cap.opencodeTurns(ocMessages);
  t('opencode capture: turns keep text and tool actions', ocTurns.length === 3 && ocTurns[2].content === 'bash npm test'
    && ocTurns[0].timestamp === '2026-09-15T04:00:00.000Z');
  t('opencode capture: last assistant text carries the marker', cap.lastAssistantText(ocMessages).endsWith('===AGENTDECK_DONE==='));
  const diagFile = join(work, 'oc-diag.jsonl');
  writeFileSync(diagFile, '');
  const capEnv = hsEnv({ HINDSIGHT_DIAG_FILE: diagFile });
  const ocFirst = await cap.captureSession({ root: repo, cwd: proj, sessionId: 'ses_1', turns: ocTurns, env: capEnv });
  await cap.captureSession({ root: repo, cwd: proj, sessionId: 'ses_1', turns: ocTurns, env: capEnv });
  const ocDocs = banks.get('hs-project')?.docs;
  const ocDoc = ocDocs?.get('conversation:ses_1');
  t('opencode capture: retains one conversation document in the repo bank', ocFirst.ok && ocDocs?.size === 1
    && ocDoc.update_mode === 'replace' && ocDoc.tags.includes('harness:opencode') && ocDoc.timestamp === '2026-09-15T04:00:00.000Z');
  const sentLines = calls.filter((c) => c.url.endsWith('/memories')).flatMap((c) => c.body.items[0].content.split('\n'));
  t('opencode capture: secrets on their own line are scrubbed client-side', !sentLines.join('\n').includes('sk-ant-abcdef') && !sentLines.join('\n').includes('pw@host'));
  t('opencode capture: every transcript line stays valid JSON', sentLines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  t('opencode capture: writes the shared diag stream', read(diagFile).includes('"trigger":"samebrain-terminal"'));
  t('opencode capture: nothing to send without a user turn', (await cap.captureSession({ root: repo, cwd: proj, sessionId: 'ses_2', turns: [], env: capEnv })).skipped === true);
  banks.delete('hs-project');

  // Bank setup: knowledge pages + directives, idempotent; session start then reads the pages.
  const bankSetup = await runAsync(join(repo, 'bin', 'hindsight-banks.mjs'), [], { env: hsEnv() });
  const appPages = banks.get('widgets-app')?.pages ?? [];
  t('hindsight: bank setup creates knowledge pages and directives on every dev bank', bankSetup.status === 0
    && ['global', 'widgets-app'].every((bk) => banks.get(bk)?.pages?.length === 4 && banks.get(bk)?.directives?.length === 2));
  t('hindsight: pages refresh daily from observations; work in flight rebuilds in full', appPages.every((pg) => JSON.stringify(pg.trigger.fact_types) === '["observation"]'
    && pg.trigger.exclude_mental_models && pg.trigger.include_chunks === false && pg.trigger.refresh_after_consolidation === false
    && /^\d+ \d+ \* \* \*$/.test(pg.trigger.refresh_cron))
    && appPages.find((pg) => pg.name === 'Current work in flight')?.trigger.mode === 'full'
    && appPages.filter((pg) => pg.trigger.mode === 'delta').length === 3);
  const setupAgain = await runAsync(join(repo, 'bin', 'hindsight-banks.mjs'), ['--check'], { env: hsEnv() });
  t('hindsight: bank setup is idempotent', setupAgain.status === 0 && !setupAgain.stdout.includes('create') && !setupAgain.stdout.includes('update'));
  mkdirSync(join(work, 'widgets-app'), { recursive: true });
  execFileSync('git', ['init', '-q', join(work, 'widgets-app')]);
  const withPages = await runAsync(join(repo, 'hooks', 'recall.mjs'), [], { env: hsEnv(), input: JSON.stringify({ cwd: join(work, 'widgets-app') }) });
  t('hindsight: session start reads knowledge pages before the recall supplement', withPages.stdout.includes('## Knowledge pages')
    && withPages.stdout.includes('page body for Active gotchas in widgets-app')
    && withPages.stdout.indexOf('## Knowledge pages') < withPages.stdout.indexOf('## Recalled'));
  for (const bk of ['global', 'widgets-app']) banks.delete(bk);

  // A hung server costs at most the configured recall timeout, never the session.
  const slow = join(work, 'slow-bank');
  mkdirSync(slow, { recursive: true });
  execFileSync('git', ['init', '-q', slow]);
  const hung = await runAsync(join(repo, 'hooks', 'recall.mjs'), [], { env: hsEnv(), input: JSON.stringify({ cwd: slow }) });
  t('hindsight: a cold bank on a hung server is bounded by the short budget', hung.status === 0 && hung.ms < 3500
    && hung.stdout.includes('<shared-agent-memory') && !hung.stdout.includes('slow fact'));
  // Stale-while-revalidate: the missed recall is refreshed in the background for the next session.
  const cacheFile = join(hsHome, '.hindsight', 'samebrain-recall-cache', 'slow-bank.json');
  for (let i = 0; i < 60 && !existsSync(cacheFile); i += 1) await new Promise((r) => { setTimeout(r, 250); });
  t('hindsight: background refresher caches the recall the session missed', existsSync(cacheFile)
    && read(cacheFile).includes('slow fact for slow-bank') && (process.platform === 'win32' || (statSync(cacheFile).mode & 0o777) === 0o600));
  const warm = await runAsync(join(repo, 'hooks', 'recall.mjs'), [], { env: hsEnv({ SAMEBRAIN_HINDSIGHT_REVALIDATE: '0' }), input: JSON.stringify({ cwd: slow }) });
  t('hindsight: next session injects the cached recall with its age, without waiting', warm.ms < 2500
    && /## Recalled from slow-bank \(cached, recalled \d+m ago\)\n- slow fact for slow-bank/.test(warm.stdout));
  t('hindsight: a live result inside the budget is labelled live', recalled.stdout.includes('## Recalled from hs-project (live)'));
  // Cache first: a bank with a fresh cache is injected from it and sends nothing to the server.
  calls.length = 0;
  const cacheFirst = await runAsync(join(repo, 'hooks', 'recall.mjs'), [], { env: hsEnv(), input: JSON.stringify({ cwd: proj }) });
  await new Promise((r) => { setTimeout(r, 500); });
  t('hindsight: a fresh cache is served immediately with no server read', /## Recalled from hs-project \(cached, recalled \d+m ago\)/.test(cacheFirst.stdout)
    && !calls.some((c) => c.url.startsWith('/v1/default/banks/hs-project/')));

  // Single flight: a bank with no cache whose live read is already in flight elsewhere adds no load.
  const lockedRepo = join(work, 'hs-locked');
  mkdirSync(lockedRepo, { recursive: true });
  execFileSync('git', ['init', '-q', lockedRepo]);
  const lock = join(hsHome, '.hindsight', 'samebrain-recall-cache', 'hs-locked.json.lock');
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, '999999');
  calls.length = 0;
  const shared = await runAsync(join(repo, 'hooks', 'recall.mjs'), [], { env: hsEnv({ SAMEBRAIN_HINDSIGHT_REVALIDATE: '0' }), input: JSON.stringify({ cwd: lockedRepo }) });
  t('hindsight: concurrent session starts share one live recall per bank', shared.status === 0
    && !calls.some((c) => c.url.startsWith('/v1/default/banks/hs-locked/')) && existsSync(lock));
  rmSync(lock, { force: true });
  const released = await runAsync(join(repo, 'hooks', 'recall.mjs'), [], { env: hsEnv(), input: JSON.stringify({ cwd: lockedRepo }) });
  t('hindsight: a finished live recall releases its lock', released.stdout.includes('(live)') && !existsSync(lock));

  // search CLI: exit codes the opencode plugin keys its fallback on.
  const search = (args, extra) => runAsync(join(repo, 'bin', 'memory-search.mjs'), args, { env: hsEnv(extra) });
  const hit = await search(['deploy gotchas', '--cwd', proj]);
  t('hindsight: memory-search exits 0 with repo + global results', hit.status === 0
    && hit.stdout.includes('## bank hs-project') && hit.stdout.includes('## bank global'));
  const off3 = await search(['anything'], { SAMEBRAIN_HINDSIGHT: '0' });
  t('hindsight: memory-search exits 3 when disabled', off3.status === 3);

  // backfill: fake HOME with every source; dry run is offline, real run is idempotent.
  const bf = join(work, 'home-backfill');
  const sbDir = join(work, 'sb-memory');
  mkdirSync(join(sbDir, 'memory', 'topics'), { recursive: true });
  writeFileSync(join(sbDir, 'memory', 'MEMORY.md'), '- index fact\n');
  writeFileSync(join(sbDir, 'memory', 'topics', 'infra.md'), '# infra\nDB is postgres://admin:hunter2@db.internal:5432/app\n');
  const autoMem = join(bf, '.claude', 'projects', `-${bf.slice(1).replaceAll('/', '-')}`, 'memory');
  mkdirSync(autoMem, { recursive: true });
  writeFileSync(join(autoMem, 'note.md'), 'auto memory note\n');
  mkdirSync(join(bf, '.codex', 'memories'), { recursive: true });
  writeFileSync(join(bf, '.codex', 'memories', 'MEMORY.md'), '# Task Group: One\n\nfirst group body text long enough\n\n# Task Group: Two\n\nsecond group body text long enough\n');
  const claudeProj = join(bf, '.claude', 'projects', '-proj');
  mkdirSync(claudeProj, { recursive: true });
  const secret = `sk-ant-${'a'.repeat(30)}`;
  writeFileSync(join(claudeProj, 'sess-claude.jsonl'), [
    { type: 'user', cwd: proj, sessionId: 'sess-claude', timestamp: '2026-09-10T10:00:00Z', message: { role: 'user', content: `fix the deploy, key is ${secret}` } },
    { type: 'assistant', cwd: proj, sessionId: 'sess-claude', timestamp: '2026-09-10T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed it.<system-reminder>injected</system-reminder>' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'deploy.sh' } }] } },
    { type: 'user', cwd: proj, sessionId: 'sess-claude', isMeta: true, message: { role: 'user', content: 'meta' } },
  ].map((l) => JSON.stringify(l)).join('\n'));
  const codexDir = join(bf, '.codex', 'sessions', '2026', '09', '10');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'rollout-x.jsonl'), [
    { type: 'session_meta', payload: { id: 'sess-codex', cwd: join(work, 'gone-worktree'), git: { repository_url: 'https://github.com/acme/widgets.git' } } },
    { type: 'response_item', timestamp: '2026-09-10T11:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'response_item', timestamp: '2026-09-10T11:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add retries' }] } },
    { type: 'response_item', timestamp: '2026-09-10T11:00:02Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n'));
  const bfEnv = (extra = {}) => ({ ...process.env, HOME: bf, USERPROFILE: bf, ...extra });
  const backfill = (args, extra) => runAsync(join(repo, 'bin', 'hindsight-backfill.mjs'), ['--samebrain-dir', sbDir, ...args], { env: bfEnv(extra) });

  calls.length = 0;
  const dry = await backfill(['--dry-run', '--verbose'], { SAMEBRAIN_HINDSIGHT: '0' });
  t('backfill: dry run exits 0 without network', dry.status === 0 && calls.length === 0);
  t('backfill: dry run counts every source', ['samebrain-memory', 'claude-memory', 'codex-memory', 'claude-session', 'codex-session'].every((s) => dry.stdout.includes(s)));
  t('backfill: dry run prices the run', /estimate: \$\d+\.\d\d/.test(dry.stdout));
  t('backfill: session routed to its repository bank', dry.stdout.includes('hs-project  conversation:sess-claude'));
  t('backfill: deleted worktree attributed via codex git remote', dry.stdout.includes('widgets  conversation:sess-codex'));
  t('backfill: unknown source fails loud', (await backfill(['--dry-run', '--sources', 'nope'])).status === 1);

  tenant.leaky = true;
  const leaked = await backfill([]);
  t('backfill: canary leak aborts before any real document is sent', leaked.status === 1
    && leaked.stderr.includes('LEAKED') && ![...banks.keys()].some((k) => !k.startsWith('samebrain-canary-')));
  t('backfill: leaked canary bank is still deleted', banks.size === 0);
  tenant.leaky = false;
  calls.length = 0;
  const first = await backfill([]);
  const stored = banks.get('widgets')?.docs.get('conversation:sess-codex');
  const topic = banks.get('global')?.docs.get('samebrain:memory/topics/infra.md');
  t('backfill: real run exits 0', first.status === 0);
  const canaryPost = calls.find((c) => c.method === 'POST' && c.url.startsWith('/v1/default/banks/samebrain-canary-'));
  t('backfill: canary sent raw before real documents', canaryPost?.body.items[0].content.includes('sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE0000')
    && calls.indexOf(canaryPost) < calls.findIndex((c) => c.method === 'POST' && c.url === '/v1/default/banks/widgets/memories'));
  t('backfill: canary bank deleted after a clean check', first.stdout.includes('redaction canary')
    && ![...banks.keys()].some((k) => k.startsWith('samebrain-canary-')));
  t('backfill: no bank-config probing or pre-create', !calls.some((c) => c.method === 'PUT' || c.url.endsWith('/config')));
  t('backfill: repo sessions land in their bank', banks.get('hs-project')?.docs.has('conversation:sess-claude'));
  t('backfill: session document matches live write-back shape', /^Codex CLI session transcript between the user and a coding agent in the widgets repository$/.test(stored?.context ?? '')
    && stored.strategy === 'conversation' && stored.content.startsWith('{"role":"system","content":"REF-ID: conversation:sess-codex"')
    && !stored.content.includes('environment_context') && stored.metadata.backfill === 'samebrain');
  const retained = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/memories') && !c.url.includes('samebrain-canary-'))
    .map((c) => c.body.items[0]);
  const firstCurated = retained.findIndex((i) => i.tags.includes('source:memory-file'));
  const sessionTimes = retained.slice(0, firstCurated).map((i) => i.timestamp);
  t('backfill: every item carries its original timestamp', retained.length > 0 && retained.every((i) => typeof i.timestamp === 'string' && i.timestamp)
    && retained.find((i) => i.document_id === 'conversation:sess-claude')?.timestamp === '2026-09-10T10:00:00Z');
  t('backfill: sessions go oldest → newest, curated memory files last', firstCurated === 2
    && JSON.stringify(sessionTimes) === JSON.stringify([...sessionTimes].sort())
    && retained.slice(firstCurated).every((i) => i.tags.includes('source:memory-file')));
  t('backfill: memory files replace, every item consolidates into one shared scope', retained.every((i) => i.observation_scopes === 'shared')
    && retained.filter((i) => i.tags.includes('source:memory-file')).every((i) => i.update_mode === 'replace' && i.metadata.path));
  const retainCalls = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/memories') && !c.url.includes('samebrain-canary-'));
  t('backfill: every retain carries a UUID operation id', retainCalls.every((c) => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.body.operation_id))
    && new Set(retainCalls.map((c) => c.body.operation_id)).size === retainCalls.length);
  t('backfill: items tagged by source with path/session in metadata', retained.some((i) => i.tags.includes('source:claude-session') && i.metadata.session_id === 'sess-claude')
    && retained.some((i) => i.tags.includes('source:codex-session') && i.metadata.path.endsWith('rollout-x.jsonl')));
  t('backfill: content scrubbed client-side', topic && !topic.content.includes('hunter2') && topic.content.includes('[REDACTED:db_url_postgres]'));
  const retains = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/memories') && !c.url.includes('samebrain-canary-')).length;
  const second = await backfill([]);
  t('backfill: second run sends nothing new', second.status === 0
    && calls.filter((c) => c.method === 'POST' && c.url.endsWith('/memories') && !c.url.includes('samebrain-canary-')).length === retains);
  rmSync(join(bf, '.hindsight'), { recursive: true, force: true });
  const noLedger = await backfill([]);
  t('backfill: server copy keeps it idempotent without the ledger', noLedger.stdout.includes('already present')
    && calls.filter((c) => c.method === 'POST' && c.url.endsWith('/memories') && !c.url.includes('samebrain-canary-')).length === retains);
  const beforeResend = calls.length;
  const resent = await backfill(['--resend']);
  t('backfill: --resend re-retains unchanged backfill documents', resent.status === 0
    && calls.slice(beforeResend).filter((c) => c.method === 'POST' && c.url.endsWith('/memories') && !c.url.includes('samebrain-canary-')).length === retained.length);
  rmSync(join(bf, '.hindsight'), { recursive: true, force: true });
  banks.clear();
  const capped = await backfill(['--max-usd', '0.0001']);
  t('backfill: spend cap stops before sending', capped.stdout.includes('cap reached') && banks.size === 0);

  // Outage: an unreachable server must not delay session start past the recall cap.
  await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  const offline = await runAsync(join(repo, 'hooks', 'recall.mjs'), [], { env: hsEnv(), input: JSON.stringify({ cwd: proj }) });
  t('hindsight: offline recall still emits the index, with the last cached recall', offline.status === 0 && offline.stdout.includes('<shared-agent-memory')
    && /## Recalled from hs-project \(cached, recalled \d+m ago\)/.test(offline.stdout) && !offline.stdout.includes('(live)'));
  t('hindsight: offline recall stays under 5s', offline.ms < 5000);
  const offSearch = await search(['anything', '--cwd', proj]);
  t('hindsight: memory-search exits 3 when unreachable', offSearch.status === 3);
  rmSync(join(repo, 'secrets.env'), { force: true });
}

// 38. Client-side scrub mirrors the server's memory_defense patterns
{
  const { scrub } = await import(join(repo, 'hooks', 'hindsight.mjs'));
  const sample = [
    `anthropic sk-ant-${'x'.repeat(24)}`,
    `github ghp_${'A'.repeat(36)}`,
    'jwt eyJabcdefghijk.eyJabcdefghijk.abcdefghijkl',
    'op://vault/item/field',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
    'ssn 123-45-6789',
  ].join('\n');
  const out = scrub(sample);
  t('scrub: provider keys redacted', out.includes('[REDACTED:anthropic_key]') && out.includes('[REDACTED:github_token]'));
  t('scrub: jwt, op:// and ssn redacted', out.includes('[REDACTED:jwt]') && out.includes('[REDACTED:op_reference]') && out.includes('[REDACTED:ssn_us]'));
  t('scrub: whole private key block removed', !out.includes('b3BlbnNzaC1rZXk'));
  t('scrub: ordinary prose untouched', scrub('deploy api-main to prod after tests') === 'deploy api-main to prod after tests');
}

// 39. Hook commands use a stable node path, identical no matter which node binary runs render
{
  const nodeHome = join(work, 'home-node-path');
  mkdirSync(join(nodeHome, '.local', 'bin'), { recursive: true });
  const altNode = join(work, 'alt-node-bin', 'node');
  mkdirSync(dirname(altNode), { recursive: true });
  copyFileSync(process.execPath, altNode, fsConstants.COPYFILE_FICLONE);
  chmodSync(altNode, 0o755);
  const hookFiles = [['.claude', 'settings.json'], ['.codex', 'hooks.json'], ['.cursor', 'hooks.json']];
  const snapshot = () => hookFiles.map((f) => read(join(nodeHome, ...f))).join('\n---\n');
  const renderWith = (bin) => spawnSync(bin, [join(repo, 'bin', 'render.mjs')], {
    env: { ...process.env, HOME: nodeHome, USERPROFILE: nodeHome, SB_FILE_TOKEN: 'x', SAMEBRAIN_NODE: '' }, encoding: 'utf8',
  });
  const first = renderWith(process.execPath);
  const a = snapshot();
  const second = renderWith(altNode);
  const b = snapshot();
  t('node path: render under two node binaries writes identical hook files', first.status === 0 && second.status === 0 && a === b);
  t('node path: the running binary never leaks into hook commands', !b.includes(altNode));
  t('node path: second render reports no hook changes', !second.stdout.includes('hooks.json') && !second.stdout.includes('settings.json'));
  symlinkSync(altNode, join(nodeHome, '.local', 'bin', 'node'));
  renderWith(process.execPath);
  t('node path: ~/.local/bin/node is preferred when present', read(join(nodeHome, '.codex', 'hooks.json')).includes(JSON.stringify(`"${join(nodeHome, '.local', 'bin', 'node')}"`).slice(1, -1)));
}

// 21. Invariants: no services, no LLM APIs anywhere in engine code (Hindsight is an opt-in client)
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
