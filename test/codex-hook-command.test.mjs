import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexHookCommand, hookCommandSource } from '../bin/codex-hook-command.mjs';

test('Unix hook commands keep the existing launcher', () => {
  assert.equal(codexHookCommand('/bin/node', '/home/me/hook.mjs', '--agent codex', 'linux'), '"/bin/node" "/home/me/hook.mjs" --agent codex');
});

test('Windows hooks preserve stdin, Unicode, stderr and native exit codes in both shells', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex hook '));
  const script = join(dir, "hook $probe ` ' quoted.mjs");
  writeFileSync(script, `let input = ''; process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
if (process.argv[2] === 'delay') await new Promise(resolve => setTimeout(resolve, 3500));
process.stdout.write(JSON.stringify({ input: JSON.parse(input), args: process.argv.slice(2) }));
if (process.argv[2] === '2') process.stderr.write('blocked by fixture');
process.exitCode = process.argv[2] === 'delay' ? 0 : Number(process.argv[2]);`);
  const payload = { prompt: 'Caf\u00e9 \u2713 \ud83d\ude42', cwd: dir };
  try {
    for (const code of [0, 1, 2, 7, 'delay']) {
      const command = codexHookCommand(process.execPath, script, `${code} --agent codex`);
      assert.ok(hookCommandSource(command).includes("hook $probe ` '' quoted.mjs"));
      for (const [shell, args] of [
        [process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]],
        ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]],
      ]) {
        const result = spawnSync(shell, args, { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: shell.toLowerCase().endsWith('cmd.exe'), timeout: code === 'delay' ? 10000 : 15000 });
        assert.equal(result.error, undefined);
        assert.equal(result.status, code === 'delay' ? 0 : code, `${shell}: ${result.stderr}`);
        assert.deepEqual(JSON.parse(result.stdout), { input: payload, args: [String(code), '--agent', 'codex'] });
        assert.equal(result.stderr, code === 2 ? 'blocked by fixture' : '');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
