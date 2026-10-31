import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'samebrain-permissions-'));
const repo = join(work, 'repo'), home = join(work, 'home');
const read = (p) => readFileSync(p, 'utf8');
const json = (p) => JSON.parse(read(p));
try {
  for (const dir of ['bin', 'global', 'hooks', 'skills', 'plugins', 'memory']) {
    cpSync(join(source, dir), join(repo, dir), { recursive: true });
  }
  // No provider credentials or network calls: exercise native configuration, not MCP provisioning.
  writeFileSync(join(repo, 'global', 'mcp.json'), '{"mcpServers":{}}');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const claude = join(home, '.claude', 'settings.json');
  const codex = join(home, '.codex', 'config.toml');
  const oc = join(home, '.config', 'opencode', 'opencode.json');
  const jsonc = join(home, '.config', 'opencode', 'opencode.jsonc');
  mkdirSync(join(home, '.kimi-code'), { recursive: true });
  const kimi = join(home, '.kimi-code', 'config.toml');
  const kimiTail = '\n[providers.test]\napi_key = "fixture-only"\n\n[[permission.rules]]\ndecision = "deny"\npattern = "Bash(secret-dump*)"\n';
  writeFileSync(kimi, '  "default_permission_mode" = "manual"\ndefault_model = "keep"\n' + kimiTail);
  writeFileSync(claude, JSON.stringify({ permissions: { defaultMode: 'auto', deny: ['Bash(secret-dump *)'], allow: ['Read'] }, custom: 'keep' }));
  writeFileSync(codex, '  "approval_policy" = "on-request"\n\tsandbox_mode = "workspace-write"\nmodel = "keep"\n\n[profiles.readonly]\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n');
  writeFileSync(oc, JSON.stringify({ permission: { '*': 'ask', bash: { 'secret-dump *': 'deny' } }, model: 'keep' }));
  const render = (...args) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, SAMEBRAIN_NODE: process.execPath };
    delete env.HINDSIGHT_API_URL;
    delete env.HINDSIGHT_API_KEY;
    const r = spawnSync(process.execPath, [join(repo, 'bin', 'render.mjs'), ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  // The template ships no execution-permissions.json: without one, even a full render changes nothing.
  render('--full');
  assert.equal(json(claude).permissions.defaultMode, 'auto');
  assert.equal(json(oc).permission['*'], 'ask');
  assert.ok(read(codex).startsWith('  "approval_policy" = "on-request"'));
  writeFileSync(join(repo, 'global', 'execution-permissions.json'), JSON.stringify({
    claude: { defaultMode: 'bypassPermissions' },
    codex: { approval_policy: 'never', sandbox_mode: 'danger-full-access' },
    opencode: { permission: 'allow' },
    kimi: { default_permission_mode: 'auto' },
  }));
  render('--memory-only');
  assert.equal(json(claude).permissions.defaultMode, 'auto');
  assert.equal(json(oc).permission['*'], 'ask');
  assert.ok(read(codex).startsWith('  "approval_policy" = "on-request"'));
  assert.ok(read(kimi).includes('default_permission_mode" = "manual"'));
  render('--full');
  assert.deepEqual(json(claude).permissions, { defaultMode: 'bypassPermissions', deny: ['Bash(secret-dump *)'], allow: ['Read'] });
  assert.equal(json(claude).custom, 'keep');
  assert.deepEqual(json(oc).permission, { '*': 'allow', bash: { 'secret-dump *': 'deny' } });
  assert.equal(json(oc).model, 'keep');
  const root = read(codex).split('[profiles.readonly]')[0];
  assert.equal((root.match(/approval_policy\s*=/g) || []).length, 1);
  assert.equal((root.match(/sandbox_mode\s*=/g) || []).length, 1);
  assert.ok(root.includes('approval_policy = "never"') && root.includes('sandbox_mode = "danger-full-access"') && root.includes('model = "keep"'));
  assert.ok(read(codex).includes('[profiles.readonly]\napproval_policy = "on-request"\nsandbox_mode = "read-only"'));
  assert.ok(read(kimi).includes('default_permission_mode = "auto"'));
  assert.ok(read(kimi).includes('default_model = "keep"'));
  assert.ok(read(kimi).endsWith(kimiTail));
  assert.equal((read(kimi).match(/default_permission_mode\s*=/g) || []).length, 1);
  assert.ok(!render().stdout.includes('standing execution permissions'));
  for (const [input, expected] of [
    ['// keep\n{"permission":"ask", "url":"https://example.com"}', '// keep\n{"permission":"allow", "url":"https://example.com"}'],
    ['{/*keep*/ "permission": {}}', '{/*keep*/ "permission": {"*": "allow"}}'],
    ['{"permission":{"read":"deny"}}', '{"permission":{"*": "allow","read":"deny"}}'],
    ['{"permission":{"bash":{"*":"deny"},"*":"ask"},"agent":{"review":{"permission":"deny"}}}', '{"permission":{"bash":{"*":"deny"},"*":"allow"},"agent":{"review":{"permission":"deny"}}}'],
    ['{"agent":{"review":{"permission":"deny"}}}', '{"agent":{"review":{"permission":"deny"}}}'],
    ['{"permiss\\u0069on":"ask"}', '{"permiss\\u0069on":"allow"}'],
    ['{"permission":{"\\u002a":"ask"}}', '{"permission":{"\\u002a":"allow"}}'],
  ]) {
    writeFileSync(jsonc, input);
    render();
    assert.equal(read(jsonc), expected);
    assert.ok(!render().stdout.includes('standing execution permissions'));
  }
  console.log('Opt-in native defaults, restriction preservation, TOML formatting, memory-only mode, JSONC precedence and idempotence pass');
} finally {
  rmSync(work, { recursive: true, force: true });
}
