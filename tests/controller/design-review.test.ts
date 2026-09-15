/** The design-review protocol: the text and step count the generic loop runs with. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DESIGN_REVIEW_PROTOCOL, DESIGN_REVIEW_PROTOCOL_MARKER, DESIGN_REVIEW_ROUNDS } from '../../src/controller/design-review.ts';

test('the protocol declares ten rounds and the shared result marker', () => {
  assert.equal(DESIGN_REVIEW_ROUNDS, 10);
  assert.equal(DESIGN_REVIEW_PROTOCOL.steps, 10);
  assert.equal(DESIGN_REVIEW_PROTOCOL.title, 'Design review');
  assert.equal(DESIGN_REVIEW_PROTOCOL.kind, 'design-review');
  assert.equal(DESIGN_REVIEW_PROTOCOL.marker, DESIGN_REVIEW_PROTOCOL_MARKER);
});

test('the brief scopes one attempt and restates the priorities and the result block', () => {
  const brief = DESIGN_REVIEW_PROTOCOL.brief({ from: 1, to: 10, score: 8, tries: 10 }, 3, 2);
  assert.match(brief, /只执行第 3 轮的第 2 次尝试/);
  assert.match(brief, /第 3 轮 · 接口审查/);
  assert.match(brief, /高内聚 > 模式完整/);
  assert.match(brief, /独立 verifier 子代理/);
  assert.match(brief, new RegExp('```' + DESIGN_REVIEW_PROTOCOL_MARKER));
  assert.match(brief, /"kind":"design-review","step":3,"attempt":2/);
  // The last round clamps to a sensible check set rather than reading past the table.
  assert.match(DESIGN_REVIEW_PROTOCOL.brief({ from: 1, to: 10, score: 8, tries: 10 }, 10, 1), /第 10 轮 · 最终收敛/);
});

test('the follow-up restates the round and budget without resending the brief', () => {
  const followUp = DESIGN_REVIEW_PROTOCOL.followUp({ from: 1, to: 10, score: 8, tries: 10 }, 3, 2);
  assert.match(followUp, /现在是第 3 轮、第 2\/10 次尝试（及格线 8）/);
  assert.match(followUp, /第 3 轮（接口审查）/);
  assert.match(followUp, /kind=design-review、step=3、attempt=2/);
  assert.doesNotMatch(followUp, /优先目标/);
});
