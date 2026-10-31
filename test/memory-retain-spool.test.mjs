// Spool contract for bin/memory-retain.mjs against a local fake Hindsight on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SRC = join(import.meta.dirname, '..');

test('failed retains queue locally, flush resends with the same operation id', async (t) => {
  let mode = 429;
  const got = [];
  const srv = http.createServer((q, s) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      got.push(JSON.parse(b));
      s.writeHead(mode, { 'content-type': 'application/json' });
      s.end(mode === 200 ? '{"operation_id":"x"}' : '{"detail":"cap"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'spooltest-'));
  t.after(() => { srv.close(); rmSync(home, { recursive: true, force: true }); });

  // A throwaway engine copy with Hindsight enabled, so the shipped template stays off.
  const root = join(home, 'engine');
  for (const dir of ['bin', 'hooks', 'global']) mkdirSync(join(root, dir), { recursive: true });
  for (const f of ['bin/memory-retain.mjs', 'hooks/hindsight.mjs']) copyFileSync(join(SRC, f), join(root, f));
  const settings = JSON.parse(readFileSync(join(SRC, 'global', 'hindsight.json'), 'utf8'));
  writeFileSync(join(root, 'global', 'hindsight.json'), JSON.stringify({ ...settings, enabled: true }));

  const env = { ...process.env, HOME: home, USERPROFILE: home, SAMEBRAIN_HINDSIGHT: '1',
    [settings.apiUrlEnv]: `http://127.0.0.1:${srv.address().port}`, [settings.apiKeyEnv]: 'test' };
  const run = (...a) => new Promise((res) => {
    const p = spawn(process.execPath, [join(root, 'bin', 'memory-retain.mjs'), ...a], { env, cwd: root, windowsHide: true });
    let o = '';
    p.stdout.on('data', (d) => { o += d; });
    p.stderr.on('data', (d) => { o += d; });
    p.on('close', (c) => res({ c, o }));
  });
  const spool = join(home, '.hindsight', 'samebrain-retain-spool.jsonl');
  const lines = () => readFileSync(spool, 'utf8').trim().split('\n').length;

  let r = await run('--global', '--title', 'A', 'fact a');
  assert.equal(r.c, 0, r.o);
  assert.match(r.o, /queued locally/);
  r = await run('--global', '--title', 'B', 'fact b');
  assert.equal(r.c, 0, r.o);
  assert.equal(lines(), 2);
  r = await run('--flush');
  assert.match(r.o, /resent 0 of 2/);
  assert.equal(lines(), 2);

  mode = 200;
  const before = got.length;
  r = await run('--flush');
  assert.match(r.o, /resent 2 of 2/, r.o);
  assert.ok(!existsSync(spool));
  assert.equal(got[before].operation_id, got[0].operation_id, 'same operation id on resend');

  mode = 400;
  r = await run('--global', '--title', 'C', 'fact c');
  assert.equal(r.c, 1, r.o);
  assert.ok(!existsSync(spool));
});
