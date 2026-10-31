// node --test test/redact-hook.test.mjs
// Automatic tool-output redaction: the Claude Code hook in hooks/redact-hook.mjs and
// the shared scrub() it reuses from hooks/hindsight.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scrub } from '../hooks/hindsight.mjs';
import { decide, isSecretProne, wrapCommand } from '../hooks/redact-hook.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(ROOT, 'hooks', 'redact-hook.mjs');
const DSN = 'postgres://u:s3cretpw@h/db';
const bash = (command, env = {}) => spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, ...env } });
const pre = (command) => decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' } });

test('printenv output with a postgres password comes back redacted', () => {
  const reply = pre('printenv DATABASE_URL');
  const { command, description } = reply.hookSpecificOutput.updatedInput;
  assert.equal(description, 'd', 'other tool_input fields survive the rewrite');
  const run = bash(command, { DATABASE_URL: DSN });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!run.stdout.includes('s3cretpw'), run.stdout);
  assert.match(run.stdout, /\[REDACTED:db_url_postgres\]/);
});

test('ls passes through with no updatedInput', () => {
  assert.equal(pre('ls -la'), null);
  assert.equal(pre('git status && npm test'), null);
});

test('a failing secret-prone command keeps its non-zero exit code', () => {
  assert.equal(bash(pre('printenv NO_SUCH_VAR_1365').hookSpecificOutput.updatedInput.command).status, 1);
  assert.equal(bash(wrapCommand(`env >/dev/null; echo ${DSN} >&2; exit 7`)).status, 7);
  assert.equal(bash(wrapCommand('yes | head -1 >/dev/null; env >/dev/null')).status, 0, 'inner SIGPIPE is not a failure');
  const stderr = bash(wrapCommand(`echo ${DSN} >&2; exit 3`));
  assert.ok(!`${stderr.stdout}${stderr.stderr}`.includes('s3cretpw'), 'stderr is redacted too');
});

test('failing exec and DB-client commands are redacted with exit code kept', () => {
  // Stubs reproduce the leak offline. The kubectl stub prints no DB-client words, so only the
  // exec pattern can trigger the wrap.
  const leak = (name) => `${name}() { echo 'invalid connection option "postgres://postgres.ref:s3cretpw@h:6543/postgres"' >&2; return 1; }; `;
  for (const [name, call] of [['kubectl', 'kubectl -n agent-platform exec -i deploy/brain -- python - < /dev/null'],
    ['docker', 'docker exec api python check.py'], ['psql', 'psql -c "select 1"']]) {
    assert.ok(isSecretProne(call), call);
    const run = bash(pre(`${leak(name)}${call}`).hookSpecificOutput.updatedInput.command);
    assert.equal(run.status, 1, `${name}: exit code survives`);
    assert.ok(!`${run.stdout}${run.stderr}`.includes('s3cretpw'), `${name}: ${run.stdout}`);
  }
});

test('a trailing comment or heredoc survives the wrap', () => {
  assert.equal(bash(wrapCommand('cat <<EOF\nhello\nEOF')).stdout, 'hello\n');
  assert.equal(bash(wrapCommand('env >/dev/null # list env')).status, 0);
});

test('scrub() handles 5 MB of input in under 1 second', () => {
  const inputs = [
    'a'.repeat(5e6),
    `${'drwxr-xr-x 1 user 197121 0 Oct 12 10:00 notes.txt 1760300000000\n'.repeat(80000)}${DSN}`.slice(-5e6),
  ];
  for (const input of inputs) {
    for (const options of [{}, { credentialsOnly: true }]) {
      const start = performance.now();
      scrub(input, options);
      const ms = performance.now() - start;
      assert.ok(ms < 1000, `scrub took ${Math.round(ms)} ms`);
    }
  }
});

test('secret-prone detection', () => {
  for (const command of ['env', 'printenv', 'sudo env', 'cd x && printenv FOO', 'echo $(env)', 'export -p',
    'kubectl get secret api -o yaml', 'kubectl exec deploy/api -- env', "kubectl exec pod -- sh -c 'printenv'",
    'docker inspect api', 'op read op://vault/item/field', 'op item get db --reveal', 'cat .env.local',
    'head -5 apps/web/.env', 'cat secrets.env', 'supabase db push --db-url "$DB"', 'gh auth token',
    // A failing psycopg connect inside a container once printed the production DSN.
    'kubectl -n agent-platform exec -i deploy/brain -- python - < q3.py', 'docker exec api python check.py',
    'python -c "import psycopg; psycopg.connect(os.environ[\'X\'])"', 'psql "$DSN" -c "select 1"',
    "python -c 'import os; print(os.environ[\"MODEL_CALL_AUDIT_DATABASE_URL\"])'", 'pg_dump "$DATABASE_URL" > x.sql',
    'podman exec db sh', 'node -e "1" && psql -c "select 1"', 'PGPASSWORD=x psql -h h', 'time pg_dump db',
    'node -e "process.env.DATABASE_URL"', `python -c "import os; os.getenv('APP_DATABASE_URL')"`]) {
    assert.ok(isSecretProne(command), command);
  }
  for (const command of ['ls', 'git log', 'npm run env:check', 'cat README.md', 'echo environment',
    'cat .env.example.md.bak/x', 'env NODE_ENV=test pytest', 'cd x && env -i bash -c true', 'printenv | node ~/samebrain/bin/redact.mjs', 'vim .env',
    'kubectl logs exec-pod', 'docker build -t exec-img .', 'kubectl get pods -n exec', 'git commit -m "fix psql quoting"', 'export APP_DATABASE_URL=x']) {
    assert.ok(!isSecretProne(command), command);
  }
});

test('PostToolUse scrubs the tool response and keeps its shape', () => {
  const response = { stdout: `DATABASE_URL=${DSN}`, stderr: '', interrupted: false };
  const reply = decide({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: response });
  const out = reply.hookSpecificOutput.updatedToolOutput;
  assert.deepEqual(Object.keys(out), Object.keys(response));
  assert.ok(!out.stdout.includes('s3cretpw'));
  assert.equal(out.interrupted, false);
});

test('normal output passes through unchanged', () => {
  const response = { stdout: 'total 8\nREADME.md\nid 1760300000000 card-like 4111 1111 1111 1111 op://vault/item/field', stderr: '' };
  assert.equal(decide({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: response }), null);
  assert.equal(decide({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { file: { content: 'plain' } } }), null);
  assert.equal(decide({ hook_event_name: 'SessionStart' }), null);
});

test('hook CLI: rewrites, scrubs, passes through, and fails open', () => {
  const run = (payload, env = {}) => spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env },
  });
  const rewritten = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'printenv' } });
  assert.match(JSON.parse(rewritten.stdout).hookSpecificOutput.updatedInput.command, /redact\.mjs/);
  const scrubbed = run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: DSN } });
  assert.ok(!scrubbed.stdout.includes('s3cretpw') && scrubbed.stdout.includes('updatedToolOutput'));
  assert.equal(run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).stdout, '');
  const broken = run('not json');
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, '');
  assert.equal(run({ hook_event_name: 'PostToolUse', tool_response: { stdout: DSN } }, { SAMEBRAIN_REDACT: '0' }).stdout, '');
});
