import test from 'node:test';
import assert from 'node:assert/strict';
import { repairHooks } from '../bin/repair-codex-plugin-hooks.mjs';
import { hookCommandSource } from '../bin/codex-hook-command.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as repair from '../bin/repair-codex-plugin-hooks.mjs';

test('repairs plugin launchers, preserves security options, and is idempotent', () => {
  for (const command of [
    'bash "${CLAUDE_PLUGIN_ROOT}/hooks/sg-python.sh" "${CLAUDE_PLUGIN_ROOT}/hooks/security_reminder_hook.py"',
    '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
  ]) {
    const hook = { type: 'command', command, asyncRewake: true, timeout: 30 };
    const config = { hooks: { Stop: [{ hooks: [hook], matcher: 'Bash' }] } };
    assert.equal(repairHooks(config, "C:/plugin 'root", 'C:/adapter.cjs', 'C:/node.exe'), 1);
    const source = hookCommandSource(hook.command_windows);
    assert.ok(source.includes("'C:/plugin ''root'"));
    assert.ok(source.includes("'hooks/"));
    assert.equal(hook.command, command);
    assert.equal(hook.asyncRewake, true);
    assert.equal(hook.timeout, 30);
    assert.equal(repairHooks(config, "C:/plugin 'root", 'C:/adapter.cjs', 'C:/node.exe'), 0);
  }
});

test('unexpected shell expressions fail rather than dropping arguments', () => {
  const config = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/a.sh" && other' }] }] } };
  assert.throws(() => repairHooks(config, 'C:/plugin', 'C:/adapter'), /Unsupported/);
});

test('cache repair detects drift without writing and repairs again after an upstream replacement', () => {
  const cache = mkdtempSync(join(tmpdir(), 'plugin-cache-'));
  const root = join(cache, 'superpowers', '6.4.1');
  const file = join(root, 'hooks', 'hooks.json');
  const original = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start', shell: 'bash', async: false }] }] } });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(file, original);
  const options = { cache, adapter: 'C:/stable/adapter.cjs', node: 'C:/stable/node.exe' };
  try {
    assert.equal(repair.repairPluginCache({ ...options, check: true }), 1);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(existsSync(`${file}.before-samebrain-windows-repair`), false);
    assert.equal(repair.repairPluginCache(options), 1);
    const repaired = readFileSync(file, 'utf8');
    assert.equal(JSON.parse(repaired).hooks.SessionStart[0].hooks[0].async, false);
    assert.equal(readFileSync(`${file}.before-samebrain-windows-repair`, 'utf8'), original);
    assert.equal(repair.repairPluginCache(options), 0);
    writeFileSync(file, original);
    assert.equal(repair.repairPluginCache(options), 1);
    assert.equal(readFileSync(file, 'utf8'), repaired);
    assert.equal(readFileSync(`${file}.before-samebrain-windows-repair`, 'utf8'), original);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});

test('Windows recall repairs replaced plugin hooks without a repository render', { skip: process.platform !== 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'recall-repair-'));
  const repo = join(home, 'samebrain');
  const file = join(home, '.codex', 'plugins', 'cache', 'claude-plugins-official', 'ralph-loop', '1.0.0', 'hooks', 'hooks.json');
  const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/stop-hook.sh"' }] }] } });
  try {
    for (const dir of ['bin', 'hooks', 'memory']) mkdirSync(join(repo, dir), { recursive: true });
    for (const relative of ['hooks/recall.mjs', 'bin/repair-codex-plugin-hooks.mjs', 'bin/codex-hook-command.mjs', 'bin/stable-node.mjs']) {
      copyFileSync(new URL(`../${relative}`, import.meta.url), join(repo, relative));
    }
    // No provider calls, git remotes, render script or background jobs in this fixture.
    const exports = ['ageLabel', 'bankForCwd', 'claimRecall', 'formatResults', 'loadHindsight', 'readPages', 'readRecallCache', 'recall', 'releaseRecall', 'writeRecallCache'];
    writeFileSync(join(repo, 'hooks', 'hindsight.mjs'), exports.map(name => `export const ${name} = () => null;`).join('\n'));
    writeFileSync(join(repo, 'hooks', 'git-sync.mjs'), "export const syncGit = () => ({ status: 'current' });\nexport const syncWarning = () => '';");
    writeFileSync(join(repo, 'memory', 'MEMORY.md'), 'Fixture memory');
    mkdirSync(join(file, '..'), { recursive: true });
    for (let run = 0; run < 2; run++) {
      writeFileSync(file, original);
      const result = spawnSync(process.execPath, [join(repo, 'hooks', 'recall.mjs')], {
        input: '{}', encoding: 'utf8', windowsHide: true, timeout: 20000,
        env: { ...process.env, USERPROFILE: home, HOME: home, SAMEBRAIN_NODE: process.execPath },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /Fixture memory/);
      const hook = JSON.parse(readFileSync(file, 'utf8')).hooks.Stop[0].hooks[0];
      assert.ok(hook.command_windows);
      assert.equal(hook.command, JSON.parse(original).hooks.Stop[0].hooks[0].command);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
