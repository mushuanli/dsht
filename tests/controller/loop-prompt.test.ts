/** The ad-hoc `/loop` protocol: a free-form prompt wrapped in the scored loop's contract. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptLoopProtocol } from '../../src/controller/loop-prompt.ts';

test('the prompt becomes the protocol, with a readable label', () => {
  const protocol = promptLoopProtocol('帮我优化这个函数\n并给出理由');
  assert.equal(protocol.kind, 'loop');
  assert.equal(protocol.marker, 'dsht-loop');
  assert.equal(protocol.steps, 1);
  assert.equal(protocol.title, 'Loop · 帮我优化这个函数 并给出理由');
  assert.equal(promptLoopProtocol('x'.repeat(80)).title, `Loop · ${'x'.repeat(39)}…`);
});

test('the first send keeps the prompt verbatim and states the contract', () => {
  const prompt = '帮我优化这个函数\n第二行也要保留';
  const brief = promptLoopProtocol(prompt).brief({ from: 1, to: 1, score: 8.5, tries: 3 }, 1, 1);
  // The operator's text survives line breaks; the contract names the score and the result block.
  assert.ok(brief.startsWith(prompt + '\n'));
  assert.match(brief, /第 1 轮第 1 次尝试（共 1 轮，及格线 8.5，每轮最多 3 次）/);
  assert.match(brief, /verifier 子代理/);
  assert.match(brief, /"kind":"loop","step":1,"attempt":1/);
  assert.match(brief, /"status":"done\|retry\|blocked"/);
  assert.match(brief, /score 小于 8.5 时 status 必须是 retry/);
  assert.match(brief, /evidence 必须给出评分的依据/);
});

test('a verification standard is injected and marked on the label', () => {
  const plain = promptLoopProtocol('do the thing');
  const verified = promptLoopProtocol('do the thing', 'npm test 必须通过\n不得新增 any');
  assert.equal(plain.title, 'Loop · do the thing');
  assert.equal(verified.title, 'Loop · do the thing (verified)');
  assert.match(plain.brief({ from: 1, to: 1, score: 8, tries: 1 }, 1, 1), /评分标准：未提供/);
  const brief = verified.brief({ from: 1, to: 1, score: 8, tries: 1 }, 1, 1);
  assert.match(brief, /评分标准（逐条对照）：/);
  assert.match(brief, /npm test 必须通过\n不得新增 any/);
});

test('a later attempt only asks for the unfinished part', () => {
  const followUp = promptLoopProtocol('do the thing').followUp({ from: 1, to: 3, score: 8, tries: 10 }, 2, 3);
  assert.match(followUp, /现在是第 2 轮、第 3\/10 次尝试（及格线 8）/);
  assert.match(followUp, /以最初的要求为准/);
  assert.match(followUp, /kind=loop、step=2、attempt=3/);
  assert.doesNotMatch(followUp, /do the thing/);
});
