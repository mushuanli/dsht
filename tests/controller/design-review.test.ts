/** The `/design-review` protocol: defaults, the score contract, and the loop it drives. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { designReviewBrief, designReviewFollowUp, latestAssistantText, parseReviewScore, resolveDesignReview } from '../../src/controller/design-review.ts';
import { ReviewRun } from '../../src/controller/review-run.ts';

test('the defaults match the documented protocol and a reversed range is refused', () => {
  assert.deepEqual(resolveDesignReview({}), { from: 1, to: 10, score: 8, tries: 10 });
  assert.deepEqual(resolveDesignReview({ from: 3, to: 5, score: 8.5, tries: 4 }), { from: 3, to: 5, score: 8.5, tries: 4 });
  assert.equal(resolveDesignReview({ from: 5, to: 1 }), undefined);
});

test('the score is read from the last dsht-review block only', () => {
  const reply = [
    'finding: something',
    '```dsht-review', '{"round":1,"attempt":1,"score":6}', '```',
    'more prose',
    '```dsht-review', '{"round":1,"attempt":2,"score":8.5}', '```',
  ].join('\n');
  assert.equal(parseReviewScore(reply), 8.5);
  // A numeric string is accepted; anything missing, malformed or out of range is not.
  assert.equal(parseReviewScore('```dsht-review\n{"score":"9.5"}\n```'), 9.5);
  assert.equal(parseReviewScore('no block here'), undefined);
  assert.equal(parseReviewScore('```dsht-review\n{not json}\n```'), undefined);
  assert.equal(parseReviewScore('```dsht-review\n{"score":11}\n```'), undefined);
  assert.equal(parseReviewScore('```dsht-review\n{"ok":true}\n```'), undefined);
});

test('the turn text is gathered from the last user boundary to the end', () => {
  const messages = [
    { seq: 0, role: 'You', text: 'do it', parts: [] },
    { seq: 1, role: 'Assistant', text: 'first half', parts: [] },
    { seq: 2, role: 'Tool', text: '✓ tool', parts: [] },
    { seq: 3, role: 'Assistant', text: 'second half', parts: [] },
  ];
  assert.equal(latestAssistantText(messages), 'first half\nsecond half');
  assert.equal(latestAssistantText([{ seq: 0, role: 'You', text: 'hi', parts: [] }]), '');
});

test('a round retries below the score, advances at it, and stops when the budget runs out', () => {
  const run = new ReviewRun('s1', { from: 1, to: 2, score: 8, tries: 2 });
  assert.equal(run.active, true);
  assert.equal(run.progress.round, 1);
  // A low score costs one attempt; a missing score does too, and can exhaust the budget.
  assert.equal(run.settle(7).kind, 'continue');
  assert.equal(run.progress.attempt, 2);
  assert.equal(run.settle(7.9).kind, 'exhausted');
  assert.equal(run.progress.phase, 'exhausted');
  assert.equal(run.progress.best, 7.9);
  assert.equal(run.active, false);
});

test('reaching the score advances one round and the last round finishes the run', () => {
  const run = new ReviewRun('s1', { from: 1, to: 2, score: 8, tries: 3 });
  const advanced = run.settle(8);
  assert.equal(advanced.kind, 'continue');
  assert.equal(run.progress.round, 2);
  assert.equal(run.progress.attempt, 1);
  assert.equal(run.progress.best, 0);
  assert.equal(run.settle(9.5).kind, 'passed');
  assert.equal(run.progress.phase, 'passed');
});

test('the brief scopes one attempt and the follow-up restates round and budget', () => {
  const run = { from: 1, to: 10, score: 8, tries: 10 };
  const brief = designReviewBrief(run, 3, 2);
  assert.match(brief, /只执行第 3 轮的第 2 次尝试/);
  assert.match(brief, /第 3 轮 · 接口审查/);
  assert.match(brief, /dsht-review/);
  assert.match(brief, /verdict 必须是 retry/);
  const followUp = designReviewFollowUp(run, 3, 2);
  assert.match(followUp, /第 3 轮、第 2\/10 次尝试/);
  assert.match(followUp, /dsht-review JSON 块/);
});

test('cancelling ends the loop and it never continues', () => {
  const run = new ReviewRun('s1', { from: 1, to: 10, score: 8, tries: 10 });
  run.cancel();
  assert.equal(run.active, false);
  assert.equal(run.progress.phase, 'cancelled');
});
