import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The fake `gh` is an extensionless shebang script on a ':'-joined PATH, which Windows cannot run.
const skip = process.platform === 'win32' && 'needs a POSIX shebang shim for gh; covered on macOS/Linux';
const unixTest = (name, fn) => test(name, { skip }, fn);

function runSweep(t, { apply = false, denied = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stale-claim-sweep-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const log = join(dir, 'calls.jsonl');
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] !== 'api' || args[1] === 'graphql') {
  console.error('Proxy refuses auth-status and GraphQL transport'); process.exit(1);
}
if (args.includes('--paginate')) { console.error('Numeric-ID repository pagination paths rejected (HTTP 403)'); process.exit(1); }
if (process.env.TEST_DENIED === '1') { console.error('HTTP403: denied'); process.exit(1); }
const endpoint = args[1];
const methodAt = args.indexOf('--method');
const method = methodAt === -1 ? 'GET' : args[methodAt + 1];
const old = '2020-01-01T00:00:00Z';
const issue = (number, labels) => ({ number, title: 'Fixture issue', labels: labels.map(name => ({name})), updated_at: old });
if (endpoint === 'user') console.log(JSON.stringify({login:'owner'}));
else if (endpoint === 'repos/fixture/project/labels/stale-claim' && method === 'GET') console.log(JSON.stringify({name:'stale-claim'}));
else if (endpoint === 'repos/fixture/project/issues?state=open&per_page=100&page=1') console.log(JSON.stringify([issue(42,['agent:codex']), issue(43,['agent:codex','stale-claim']), ...Array.from({length:98},(_,i)=>({...issue(90+i,[]),pull_request:{url:'fixture'}}))]));
else if (endpoint === 'repos/fixture/project/pulls?state=open&per_page=100&page=1') console.log(JSON.stringify([{number:91,body:'Fixes #43. Also mentions #142.'}]));
else if (endpoint === 'repos/fixture/project/issues/42/comments?per_page=100&page=1') console.log(JSON.stringify([{id:271,node_id:'IC_fixture',user:{login:'owner'},body:'<!-- stale-claim-sweep --> prior warning',created_at:old,updated_at:old}]));
else if (endpoint === 'repos/fixture/project/issues?state=open&per_page=100&page=2') console.log(JSON.stringify([issue(44,[])]));
else if (method === 'POST' && endpoint === 'repos/fixture/project/issues/42/labels') console.log(JSON.stringify([{name:'stale-claim'}]));
else if (method === 'DELETE' && endpoint === 'repos/fixture/project/issues/43/labels/stale-claim') console.log('{}');
else if (method === 'PATCH' && endpoint === 'repos/fixture/project/issues/comments/271') console.log('{}');
else { console.error('Unexpected request', endpoint, method); process.exit(1); }
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./stale-claim-sweep.mjs', import.meta.url)), '--repo', 'fixture/project', ...(apply ? ['--apply'] : [])], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'proxy-injected', GITHUB_TOKEN: 'proxy-injected', TEST_CALL_LOG: log, TEST_DENIED: denied ? '1' : '0' },
  });
  return { ...result, calls: readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

unixTest('proxy-authenticated dry-run reports stale and revived claims without mutations', (t) => {
  const result = runSweep(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 flagged, 1 cleared, 1 live claims, 3 open issues scanned/);
  assert.ok(result.calls.some(args => args[1] === 'repos/fixture/project/issues?state=open&per_page=100&page=2'));
  assert.equal(result.calls.some(args => args.includes('--method') && args[args.indexOf('--method') + 1] !== 'GET'), false);
});

unixTest('REST apply refreshes its owned warning and only maintains the stale label', (t) => {
  const result = runSweep(t, { apply: true });
  assert.equal(result.status, 0, result.stderr);
  const writes = result.calls.filter(args => args.includes('--method') && args[args.indexOf('--method') + 1] !== 'GET');
  assert.deepEqual(writes.map(args => [args[1], args[args.indexOf('--method') + 1]]), [
    ['repos/fixture/project/issues/42/labels', 'POST'],
    ['repos/fixture/project/issues/comments/271', 'PATCH'],
    ['repos/fixture/project/issues/43/labels/stale-claim', 'DELETE'],
  ]);
  assert.match(result.stdout, /1 flagged, 1 cleared, 1 live claims/);
});

unixTest('denied REST authentication stops before any claim or warning write', (t) => {
  const result = runSweep(t, { apply: true, denied: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 1);
  assert.doesNotMatch(result.stdout, /APPLIED/);
});
