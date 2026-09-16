/** The design-review protocol: the text and step count the generic loop runs with. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DESIGN_REVIEW_ARTIFACT, DESIGN_REVIEW_ROUNDS, designReviewProtocol } from '../../src/controller/design-review.ts';
import { LOOP_MARKER } from '../../src/controller/loop-contract.ts';

test('the protocol declares ten rounds and the shared result marker', () => {
  const protocol = designReviewProtocol();
  assert.equal(DESIGN_REVIEW_ROUNDS, 10);
  assert.equal(protocol.steps, 10);
  assert.equal(protocol.title, 'Design review');
  assert.equal(protocol.kind, 'design-review');
  assert.equal(protocol.marker, LOOP_MARKER);
});

test('the brief scopes one attempt and restates the priorities and the result block', () => {
  const brief = designReviewProtocol().brief({ from: 1, to: 10, score: 8, tries: 10 }, 3, 2);
  assert.match(brief, /只执行第 3 轮的第 2 次尝试/);
  assert.match(brief, /第 3 轮 · 接口审查/);
  assert.match(brief, /高内聚 > 模式完整/);
  assert.match(brief, /verifier 子代理/);
  assert.match(brief, new RegExp('```' + LOOP_MARKER));
  assert.match(brief, /"kind":"design-review","step":3,"attempt":2/);
  assert.match(brief, /"status":"done\|retry\|blocked"/);
  assert.match(brief, /"evidence"/);
  // The round's own checklist is the verifier's rubric, and the artifact is a workspace file.
  assert.match(brief, /本步焦点：第 3 轮 · 接口审查/);
  assert.match(brief, /评分标准（逐条对照）：/);
  assert.match(brief, /逐个检查 public API/);
  assert.match(brief, new RegExp(`## 第 3 轮 · 接口审查`));
  assert.match(brief, new RegExp(DESIGN_REVIEW_ARTIFACT));
  // The last round clamps to a sensible check set rather than reading past the table.
  assert.match(designReviewProtocol().brief({ from: 1, to: 10, score: 8, tries: 10 }, 10, 1), /第 10 轮 · 最终收敛/);
});

test('the follow-up restates the round and budget without resending the brief', () => {
  const followUp = designReviewProtocol().followUp({ from: 1, to: 10, score: 8, tries: 10 }, 3, 2);
  assert.match(followUp, /现在是第 3 轮、第 2\/10 次尝试（及格线 8）/);
  assert.match(followUp, /第 3 轮（接口审查）/);
  assert.match(followUp, /kind=design-review、step=3、attempt=2/);
  assert.doesNotMatch(followUp, /优先目标/);
});

test('a verification standard is folded on top of the round rubric and marked on the label', () => {
  const plain = designReviewProtocol();
  const verified = designReviewProtocol('必须通过 npm test\n且不得新增 any');
  assert.equal(plain.title, 'Design review');
  assert.equal(verified.title, 'Design review (verified)');
  assert.doesNotMatch(plain.brief({ from: 1, to: 1, score: 8, tries: 1 }, 1, 1), /必须通过 npm test/);
  const brief = verified.brief({ from: 1, to: 1, score: 8, tries: 1 }, 1, 1);
  // The round checklist stays the base rubric; the operator's standard is added, not substituted.
  assert.match(brief, /逐个模块\/类\/服务\/Store/);
  assert.match(brief, /额外要求（由 \/verify 提供）：/);
  assert.match(brief, /必须通过 npm test\n且不得新增 any/);
});

test('each round names itself for the progress line', () => {
  const protocol = designReviewProtocol();
  assert.equal(protocol.stepLabel?.(1), '职责与归属');
  assert.equal(protocol.stepLabel?.(6), '删除式审查');
  assert.equal(protocol.stepLabel?.(10), '最终收敛');
  // A step outside the table still gets a readable label rather than undefined.
  assert.equal(protocol.stepLabel?.(11), '收敛审查');
});
