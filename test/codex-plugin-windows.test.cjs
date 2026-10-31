const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../hooks/codex-plugin-windows.cjs');

test('Claude telemetry becomes a valid no-op Stop response', () => {
  assert.deepEqual(JSON.parse(normalize('{"metrics":{"skipped":true},"rewakeSummary":"done"}', 'Stop', 'security-guidance')), {});
});
test('security block and complete reason survive telemetry translation', () => {
  const input = { metrics: { findings: 1 }, decision: 'block', reason: 'Fix unsafe code', systemMessage: 'Review pending' };
  assert.deepEqual(JSON.parse(normalize(JSON.stringify(input), 'Stop', 'security-guidance')),
    { decision: 'block', reason: 'Fix unsafe code', systemMessage: 'Review pending' });
});
test('subagent blocking remains blocking', () => {
  assert.deepEqual(JSON.parse(normalize('{"decision":"block","reason":"Verify patch","metrics":{}}', 'SubagentStop', 'security-guidance')),
    { decision: 'block', reason: 'Verify patch' });
});
test('Ralph successful completion notices become UI messages', () => {
  assert.deepEqual(JSON.parse(normalize('Ralph loop: Max iterations reached.\n', 'Stop', 'ralph-loop')),
    { systemMessage: 'Ralph loop: Max iterations reached.' });
});
test('unsupported stop fields fail instead of losing a check', () => {
  assert.throws(() => normalize('{"hookSpecificOutput":{"hookEventName":"Stop"}}', 'Stop', 'security-guidance'), /Unsupported/);
});
test('invalid JSON fails; an incomplete blocking decision fails', () => {
  assert.throws(() => normalize('{broken', 'Stop', 'security-guidance'), /invalid/);
  assert.throws(() => normalize('{"decision":"block"}', 'Stop', 'security-guidance'), /nonempty reason/);
});
test('session context and normal empty hook output survive', () => {
  const context = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Load skills' } };
  assert.deepEqual(JSON.parse(normalize(JSON.stringify(context), 'SessionStart', 'superpowers')), context);
  assert.equal(normalize('', 'Stop', 'ralph-loop'), '');
});
