/** The design-document review protocol: the rounds and contract the generic loop runs with. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DESIGNDOC_REVIEW_ARTIFACT, DESIGNDOC_REVIEW_ROUNDS, designdocReviewProtocol } from '../../src/controller/designdoc-review.ts';
import { LOOP_MARKER } from '../../src/controller/loop-contract.ts';

test('the protocol names its document, rounds and result marker', () => {
  const protocol = designdocReviewProtocol('tui-design.md');
  assert.equal(DESIGNDOC_REVIEW_ROUNDS, 10);
  assert.equal(protocol.steps, 10);
  assert.equal(protocol.kind, 'designdoc-review');
  assert.equal(protocol.marker, LOOP_MARKER);
  assert.equal(protocol.title, 'Designdoc review · tui-design.md');
  assert.equal(protocol.stepLabel?.(3), '与代码一致性');
  assert.equal(protocol.stepLabel?.(11), '收敛结论');
});

test('the brief scopes one round, names the document and carries the round rubric', () => {
  const brief = designdocReviewProtocol('tui-design.md').brief({ from: 1, to: 10, score: 8, tries: 10 }, 3, 2);
  assert.match(brief, /tui-design\.md/);
  assert.match(brief, /只执行第 3 轮的第 2 次尝试/);
  assert.match(brief, /第 3 轮 · 与代码一致性/);
  assert.match(brief, /import 边界/);
  assert.match(brief, /本步焦点：第 3 轮 · 与代码一致性/);
  assert.match(brief, /评分标准（逐条对照）：/);
  assert.match(brief, /"kind":"designdoc-review","step":3,"attempt":2/);
  assert.match(brief, new RegExp(`## 第 3 轮 · 与代码一致性`));
  assert.match(brief, new RegExp(DESIGNDOC_REVIEW_ARTIFACT));
});

test('the follow-up restates the round and points back at the artifact', () => {
  const followUp = designdocReviewProtocol('tui-design.md').followUp({ from: 1, to: 10, score: 8, tries: 10 }, 4, 2);
  assert.match(followUp, /现在是第 4 轮、第 2\/10 次尝试（及格线 8）/);
  assert.match(followUp, /第 4 轮（完整性与悬空引用）/);
  assert.match(followUp, /tui-design\.md/);
  assert.match(followUp, new RegExp(DESIGNDOC_REVIEW_ARTIFACT));
  assert.match(followUp, /kind=designdoc-review、step=4、attempt=2/);
});

test('a verification standard is folded on top of the round rubric', () => {
  const verified = designdocReviewProtocol('tui-design.md', '不得引用不存在的章节');
  assert.equal(verified.title, 'Designdoc review · tui-design.md (verified)');
  const brief = verified.brief({ from: 1, to: 1, score: 8, tries: 1 }, 1, 1);
  assert.match(brief, /额外要求（由 \/verify 提供）：/);
  assert.match(brief, /不得引用不存在的章节/);
  assert.match(brief, /这份文档为谁写/);
});
