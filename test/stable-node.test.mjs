import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as resolver from '../bin/stable-node.mjs';

test('configured Node spelling wins over the invoking binary and local fallback', () => {
  const home = mkdtempSync(join(tmpdir(), 'stable-node-'));
  const configured = join(home, 'configured-node.exe');
  const local = join(home, '.local', 'bin', 'node.exe');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(local, '');
  writeFileSync(configured, '');
  try {
    const env = { SAMEBRAIN_NODE: configured.replaceAll('\\', '/') };
    assert.equal(resolver.stableNode({ home, platform: 'win32', env }), env.SAMEBRAIN_NODE);
    assert.equal(resolver.stableNode({ home, platform: 'win32', env: {} }), local);
    assert.equal(resolver.stableNode({ home, platform: 'win32', env: { SAMEBRAIN_NODE: join(home, 'missing') } }), local);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
