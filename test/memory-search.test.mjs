import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

// No credentials or provider calls: execute the real CLI against a disposable
// backend. Delayed stdout models Node's documented asynchronous write contract.
function run(args, { delayOutput = false, mode = 'results' } = {}) {
  const base = realpathSync(tmpdir());
  const directory = mkdtempSync(join(base, 'memory-search-exit-'));
  try {
    mkdirSync(join(directory, 'bin'));
    mkdirSync(join(directory, 'hooks'));
    mkdirSync(join(directory, 'memory', 'topics'), { recursive: true });
    writeFileSync(join(directory, 'memory', 'MEMORY.md'), '# index\n- unrelated rule\n');
    writeFileSync(join(directory, 'memory', 'topics', 'fixture.md'), '# fixture\n- the fixture question answer lives here\n');
    const cli = join(directory, 'bin', 'memory-search.mjs');
    writeFileSync(cli, readFileSync(new URL('../bin/memory-search.mjs', import.meta.url)));
    writeFileSync(join(directory, 'hooks', 'hindsight.mjs'), `
export const bankForCwd = () => 'project';
export const bankPath = id => '/banks/' + id;
export const loadHindsight = () => process.env.MEMORY_TEST_MODE === 'unconfigured'
  ? null : { settings: { globalBank: 'global' } };
export const formatResults = results => results.map(r => r.text).join('\\n');
export async function hindsightRequest(hs, method, path, body) {
  if (process.env.MEMORY_TEST_MODE === 'unreachable') throw new Error('offline fixture unavailable');
  return { status: 200, ok: true, json: { results: process.env.MEMORY_TEST_MODE === 'empty'
    ? [] : [{ text: 'owned fixture', marker: 'complete-output' }] } };
}
`);
    const preload = join(directory, 'delayed-output.cjs');
    writeFileSync(preload, `
const original = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  setTimeout(() => original(chunk, ...args), 20);
  return true;
};
`);
    return spawnSync(process.execPath, [
      ...(delayOutput ? ['--require', preload] : []), cli, ...args,
    ], { encoding: 'utf8', timeout: 15000, env: { ...process.env, MEMORY_TEST_MODE: mode } });
  } finally {
    const resolved = realpathSync(directory);
    assert.equal(dirname(resolved), base);
    assert.ok(basename(resolved).startsWith('memory-search-exit-'));
    rmSync(resolved, { recursive: true, force: true });
  }
}

test('JSON results and success status survive asynchronous output', () => {
  const child = run(['--json', 'fixture question'], { delayOutput: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  const banks = JSON.parse(child.stdout);
  assert.deepEqual(banks.map(b => b.id), ['project', 'global']);
  assert.ok(banks.every(b => b.results[0].marker === 'complete-output'));
});

test('both plaintext bank sections survive asynchronous output', () => {
  const child = run(['fixture question'], { delayOutput: true });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout, '## bank project\nowned fixture\n\n## bank global\nowned fixture\n\n');
});

test('empty results preserve exit one and complete JSON', () => {
  const child = run(['--json', 'fixture question'], { delayOutput: true, mode: 'empty' });
  assert.equal(child.status, 1);
  assert.equal(child.stderr, '');
  assert.ok(JSON.parse(child.stdout).every(b => b.results.length === 0));
});

test('missing query retains usage exit two', () => {
  const child = run([]);
  assert.equal(child.status, 2);
  assert.match(child.stderr, /usage: memory-search/);
});

test('unconfigured memory falls back to topic lines', () => {
  const child = run(['fixture question'], { mode: 'unconfigured' });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.match(child.stdout, /## bank topics\nmemory\/topics\/fixture\.md:2: - the fixture question answer lives here/);
});

test('unreachable memory falls back to topics and says so', () => {
  const child = run(['--json', 'fixture question'], { mode: 'unreachable' });
  assert.equal(child.status, 0);
  assert.match(child.stderr, /offline fixture unavailable/);
  const [bank] = JSON.parse(child.stdout);
  assert.equal(bank.id, 'topics');
  assert.ok(bank.results[0].text.includes('fixture.md:2'));
});

test('topic fallback with no match exits one', () => {
  const child = run(['zzzqqq nothing'], { mode: 'unconfigured' });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
});
