import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepCommentState } from './stale-claim-sweep.mjs';
const stamp = '2026-10-07T12:00:00Z';
const own = { id: 'IC_owned', author: { login: 'owner' }, body: '<!-- stale-claim-sweep --> stale claim', createdAt: stamp };
test('a sweep comment does not revive its own stale claim', () => {
  assert.deepEqual(sweepCommentState([own], 'owner', stamp), { commentId: 'IC_owned', commented: true, sweepOnlyActivity: true });
});
test('later holder activity revives the claim without losing comment dedup', () => {
  assert.deepEqual(sweepCommentState([own], 'owner', '2026-10-07T12:01:00Z'), { commentId: 'IC_owned', commented: true, sweepOnlyActivity: false });
});
test('another author cannot suppress the maintained sweep with its marker', () => {
  assert.deepEqual(sweepCommentState([own], 'different', stamp), { commentId: null, commented: false, sweepOnlyActivity: false });
});
test('uncommented claims still receive their first warning', () => {
  assert.deepEqual(sweepCommentState([], 'owner', stamp), { commentId: null, commented: false, sweepOnlyActivity: false });
});

test('revival then reflag refreshes the existing warning instead of reviving itself', () => {
  assert.equal(sweepCommentState([own], 'owner', '2026-10-07T12:01:00Z').sweepOnlyActivity, false);
  const refreshed = { ...own, updatedAt: '2026-10-09T12:00:00Z' };
  assert.deepEqual(sweepCommentState([refreshed], 'owner', refreshed.updatedAt), { commentId: 'IC_owned', commented: true, sweepOnlyActivity: true });
  assert.equal(sweepCommentState([refreshed], 'owner', '2026-10-09T12:01:00Z').sweepOnlyActivity, false);
});
