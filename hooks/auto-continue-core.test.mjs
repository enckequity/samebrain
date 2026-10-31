// Run: node --test hooks/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DONE, isTerminal } from './auto-continue-core.mjs';

test('bare DONE is terminal', () => {
  assert.equal(isTerminal(`reply\n${DONE}`), true);
});

test('agent-deck status sentinel is terminal', () => {
  assert.equal(isTerminal(`${DONE} status=ok summary=shipped it`), true);
  assert.equal(isTerminal(`${DONE} status=fail summary=could not reach the api`), true);
  assert.equal(isTerminal(`result\n  ${DONE} status=ok summary=done  `), true);
});

test('the status token must be ok or fail', () => {
  assert.equal(isTerminal(`${DONE} status=maybe summary=x`), false);
  assert.equal(isTerminal(`${DONE} summary=no status field`), false);
});

test('the status value is case-insensitive and the marker may sit mid-line', () => {
  assert.equal(isTerminal(`${DONE} status=OK summary=x`), true);
  assert.equal(isTerminal(`wrapped ${DONE} status=ok summary=x`), true);
});

test('echoing the contract line does not end the run', () => {
  assert.equal(isTerminal(`${DONE} (task verified complete, or you only answered a question)`), false);
});

test('only the last line counts', () => {
  assert.equal(isTerminal(`${DONE} status=ok summary=stale mid-message\nstill working`), false);
});

test('BLOCKED and WAITING with a reason are terminal', () => {
  assert.equal(isTerminal('BLOCKED: need prod access'), true);
  assert.equal(isTerminal('WAITING: watching the PR checks'), true);
  assert.equal(isTerminal('BLOCKED:'), false);
});

test('plain text is not terminal', () => {
  assert.equal(isTerminal('ok, done for now'), false);
  assert.equal(isTerminal(''), false);
  assert.equal(isTerminal(undefined), false);
});
