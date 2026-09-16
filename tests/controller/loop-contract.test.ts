/** The forked verifier's contract: the prompt it receives and the verdict file it returns. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findingsLines, parseVerdict, resultContract, verdictBrief } from '../../src/controller/loop-contract.ts';

const identity = 'run-1/designdoc-review/2/1';
const expect = { verificationId: identity, kind: 'designdoc-review', step: 2, attempt: 1 };
const verdict = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ verificationId: identity, kind: 'designdoc-review', step: 2, attempt: 1, score: 4.5, status: 'retry', evidence: 'ran the checks', ...extra });

test('a verdict file is read however the verifier wrapped it', () => {
  const full = { score: 4.5, status: 'retry', evidence: 'ran the checks' } as const;
  assert.deepEqual(parseVerdict(verdict(), expect), full);
  // Models habitually fence JSON even when told not to, so a fence and prose are tolerated.
  assert.deepEqual(parseVerdict('```json\n' + verdict() + '\n```', expect), full);
  assert.deepEqual(parseVerdict(`结论如下：\n${verdict()}\n以上。`, expect), full);
});

test('a verdict for another round, or an unusable one, is refused', () => {
  // A file left over from an earlier round must not score this one.
  assert.equal(parseVerdict(verdict({ step: 1 }), expect), undefined);
  assert.equal(parseVerdict(verdict({ attempt: 2 }), expect), undefined);
  assert.equal(parseVerdict(verdict({ kind: 'design-review' }), expect), undefined);
  assert.equal(parseVerdict('not json at all', expect), undefined);
  assert.equal(parseVerdict('', expect), undefined);
  // A verdict from another run is refused before its round is even considered.
  assert.equal(parseVerdict(verdict({ verificationId: 'other-run/designdoc-review/2/1' }), expect), undefined);
  // Without the identity there is nothing to trust, even when the round matches.
  assert.equal(parseVerdict('{"kind":"designdoc-review","step":2,"attempt":1}', expect), undefined);
  assert.deepEqual(parseVerdict(verdict({ score: 11 }), expect), { status: 'retry', evidence: 'ran the checks' });
  assert.deepEqual(parseVerdict(verdict({ status: 'passed' }), expect), { score: 4.5, evidence: 'ran the checks' });
});

test('the verifier prompt names the file as the only channel back, and the round it judges', () => {
  const prompt = verdictBrief({ verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, file: '/w/.dsht/verdict.json',
    standard: '每条断言都要有出处', artifact: 'tui-design.md', focus: '结构与导航' });
  // The model never picks a path or opens a file: the client reads the verdict out of the reply.
  assert.doesNotMatch(prompt, /把结论写入/);
  assert.match(prompt, /回复正文的最后输出唯一一个 JSON 对象/);
  assert.match(prompt, /不要修改它/);
  assert.match(prompt, /结构与导航/);
  assert.match(prompt, /每条断言都要有出处/);
  assert.match(prompt, /"step":2,"attempt":1/);
  // The identity is embedded so the parent can reject a stale file.
  assert.match(prompt, /"kind":"designdoc-review"/);
});

test('a forked round tells the agent it is not the scorer but still keeps the fallback block', () => {
  const limits = { from: 1, to: 1, score: 8, tries: 2 };
  const forked = resultContract('designdoc-review', limits, 1, 1, { artifact: 'tui-design.md' }, 'forked').join('\n');
  assert.match(forked, /独立验证进程/);
  assert.match(forked, /不要 spawn 子代理/);
  assert.match(forked, /仍然必须存在/);
  // The fallback is the same block the reply parser reads, so its format never diverges.
  assert.match(forked, /```dsht-loop/);

  const subagent = resultContract('designdoc-review', limits, 1, 1, { artifact: 'tui-design.md' }).join('\n');
  assert.match(subagent, /spawn 一个全新的 verifier 子代理/);
  assert.doesNotMatch(subagent, /独立验证进程/);
});

test('a verdict carries findings into the retry and into the next verifier', () => {
  const result = parseVerdict(JSON.stringify({ verificationId: 'run-1/designdoc-review/2/1', kind: 'designdoc-review', step: 2, attempt: 1, score: 5, status: 'retry',
    evidence: '逐条复核后仍缺章节映射', top_findings: ['缺章节映射', '计数过期'] }), expect);
  assert.deepEqual(result, { score: 5, status: 'retry', evidence: '逐条复核后仍缺章节映射',
    findings: ['缺章节映射', '计数过期'] });

  // The retry prompt quotes the verifier verbatim, so the reviewer answers it instead of guessing.
  const retry = findingsLines(result!).join('\n');
  assert.match(retry, /缺章节映射/);
  assert.match(retry, /计数过期/);
  assert.match(retry, /逐条处理/);

  // The next verifier is told what it objected to last time, so the score reflects convergence.
  const prompt = verdictBrief({ verificationId: 'run-1/designdoc-review/2/2', kind: 'designdoc-review', step: 2, attempt: 2, file: '/w/v.json',
    previous: { step: 2, attempt: 1, result: result! } });
  assert.match(prompt, /上一次（第 2 轮第 1 次）/);
  assert.match(prompt, /缺章节映射/);
  assert.match(prompt, /没有解决的必须继续计入本轮评分/);
});

test('a verdict that explains nothing adds nothing to a prompt', () => {
  assert.deepEqual(findingsLines({ score: 4 }), []);
  const retry = findingsLines({ score: 4, top_findings: undefined } as never);
  assert.deepEqual(retry, []);
});

test('a verdict surrounded by other JSON is still found', () => {
  // A review reply is prose with evidence in it, so quoted objects sit next to the verdict.
  const quotedBefore = `先看配置：\n\`\`\`json\n{"name":"demo","nested":{"a":1}}\n\`\`\`\n结论：\n${verdict()}\n`;
  assert.deepEqual(parseVerdict(quotedBefore, expect), { score: 4.5, status: 'retry', evidence: 'ran the checks' });
  const quotedAfter = `${verdict()}\n证据：{"command":"npm test","ok":true}\n`;
  assert.deepEqual(parseVerdict(quotedAfter, expect), { score: 4.5, status: 'retry', evidence: 'ran the checks' });
  // Another run's verdict in the same reply must not be mistaken for this round's.
  const otherFirst = `${JSON.stringify({ verificationId: 'other-run/designdoc-review/2/1', score: 9 })}${verdict()}`;
  assert.deepEqual(parseVerdict(otherFirst, expect), { score: 4.5, status: 'retry', evidence: 'ran the checks' });
});
