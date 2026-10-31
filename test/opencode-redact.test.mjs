// opencode records each streamed chunk of a running shell command in its event log before
// any plugin hook sees the output. These tests drive guardrails.js the way opencode
// 1.18.31 does: tool.execute.before, the shell spawn with its argv, a running event per
// chunk, then tool.execute.after on the stored result. A fake DSN must reach neither.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSecretProne } from '../hooks/redact-hook.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = ['fake', '1368', 'pw'].join('');
const DSN = `postgres://app:${SECRET}@db.example.com:5432/app`;

let instance = 0;
async function load(env = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const source = readFileSync(join(ROOT, 'plugins', 'guardrails.js'), 'utf8')
      .replaceAll('{{REPO_URL}}', pathToFileURL(ROOT).href);
    return (await import(`data:text/javascript;base64,${Buffer.from(source + `\n// instance ${instance++}`).toString('base64')}`)).default;
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function hooks(shell, env) {
  const result = await (await load(env))({});
  await result.config({ shell });
  return result;
}

const before = (hook, args, tool = 'bash') => hook['tool.execute.before']({ tool }, { args });
const has = (cmd) => spawnSync(cmd, ['-c', 'exit 0'], { windowsHide: true }).status === 0
  || spawnSync(cmd, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0;

// opencode's argv per shell (packages/core/src/shell.ts args(), tool/shell.ts cmd()).
const ARGV = {
  bash: (command) => ['-c', command],
  pwsh: (command) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
};

async function runLikeOpencode(shell, command) {
  const hook = await hooks(shell);
  const args = { command, timeout: 10000 };
  await before(hook, args);
  assert.notEqual(args.command, command, 'secret-prone command is wrapped');
  assert.equal(args.timeout, 10000);
  assert.match(args.command, /'node'/, 'opencode process.execPath is its Bun executable, not Node');

  const eventLog = [];
  const child = spawn(shell, ARGV[shell](args.command), {
    env: { ...process.env, TS_FAKE_DSN: DSN }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    output += chunk.toString();
    eventLog.push({ type: 'message.part.updated', part: { state: { status: 'running', metadata: { output } } } });
  });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });

  const stored = { output, metadata: { output, exit } };
  await hook['tool.execute.after']({ tool: 'bash' }, stored);
  return { exit, output, eventLog, stored };
}

for (const [shell, command] of [
  ['bash', 'printenv TS_FAKE_DSN; printenv TS_FAKE_DSN >&2; exit 7'],
  ['pwsh', 'Get-ChildItem env:TS_FAKE_DSN | Format-List; [Console]::Error.WriteLine($env:TS_FAKE_DSN); exit 7'],
]) {
  test(`${shell}: fake DSN reaches neither the event log nor the stored result`, { skip: !has(shell) && `${shell} not installed` }, async () => {
    const { exit, output, eventLog, stored } = await runLikeOpencode(shell, command);
    assert.equal(exit, 7, 'exit code survives the wrapper');
    assert.ok(eventLog.length > 0, 'streamed events were recorded');
    assert.ok(!JSON.stringify(eventLog).includes(SECRET), 'event log is clean');
    assert.ok(!JSON.stringify(stored).includes(SECRET), 'stored result is clean');
    assert.equal((output.match(/\[REDACTED:db_url_postgres\]/g) ?? []).length, 2, 'stdout and stderr both redacted');
  });
}

test('PowerShell secret reads are detected', () => {
  for (const command of ['Get-ChildItem env:', 'gci env:DATABASE_URL', 'Get-Content .env.local',
    'gc C:\\app\\.env', '[Environment]::GetEnvironmentVariable("TOKEN")', 'Select-String KEY .env', 'Get-ChildItem -Path "env:"', 'gci -Filter *KEY* env:', 'echo $env:OPENAI_API_KEY']) {
    assert.ok(isSecretProne(command), command);
  }
  for (const command of ['Get-ChildItem .', 'Get-Content README.md', '$env:PATH += ";C:\\bin"', '$env:API_TOKEN = "x"; node app.js']) {
    assert.ok(!isSecretProne(command), command);
  }
});

test('normal tools and already-wrapped commands remain unchanged', async () => {
  for (const shell of ['bash', 'pwsh']) {
    const hook = await hooks(shell);
    for (const [tool, command] of [['bash', 'git status'], ['read', 'cat .env']]) {
      const args = { command };
      await before(hook, args, tool);
      assert.equal(args.command, command);
    }
    const args = { command: 'printenv TS_FAKE_DSN' };
    await before(hook, args);
    const wrapped = args.command;
    await before(hook, args);
    assert.equal(args.command, wrapped);
  }
});

test('policy checks run before wrapping', async () => {
  const hook = await hooks('bash');
  const args = { command: 'printenv FOO; git push --force' };
  await assert.rejects(before(hook, args), /force-push/);
  assert.equal(args.command, 'printenv FOO; git push --force');
});

test('shells with no wrapper block secret-prone commands; supported ones pick theirs', async () => {
  for (const shell of ['cmd.exe', '/bin/sh', 'fish']) {
    const hook = await hooks(shell);
    await assert.rejects(before(hook, { command: 'cat .env' }), /redaction/i);
    await before(hook, { command: 'git status' });
  }
  for (const [shell, marker] of [['C:/Program Files/Git/bin/bash.exe', 'pipefail'], ['/usr/bin/zsh', 'pipefail'],
    ['powershell.exe', 'Get-Process -Id $PID'], ['C:\\Users\\x\\scoop\\apps\\pwsh\\current\\pwsh.exe', 'Get-Process -Id $PID']]) {
    const hook = await hooks(shell);
    const args = { command: 'cat .env' };
    await before(hook, args);
    assert.ok(args.command.includes(marker), `${shell} -> ${marker}`);
  }
});

test('the redaction opt-out leaves commands and output unchanged', async () => {
  const hook = await hooks('cmd.exe', { SAMEBRAIN_REDACT: '0' });
  const args = { command: 'cat .env' };
  await before(hook, args);
  assert.equal(args.command, 'cat .env');
  const output = { output: DSN };
  await hook['tool.execute.after']({}, output);
  assert.equal(output.output, DSN);
});
