/** The forked verifier's contract: the prompt it receives and the verdict file it returns. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findingsLines, parseVerdict, repairJsonEscapes, resultContract, verdictBrief } from '../../src/controller/loop-contract.ts';

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

test('a verdict survives the two ways a model breaks its own JSON', () => {
  // Both shapes are from one live run whose verdict was discarded as unparsable, costing an attempt:
  // a regular expression written as `\d+\.\d+` (undefined escape) and the record's own
  // `{{placeholder}}` quoted inside `evidence` (braces inside a string).
  const escaped = '{"verificationId":"run-1/designdoc-review/2/1","kind":"designdoc-review","step":2,"attempt":1,'
    + '"score":8.4,"status":"done","evidence":"全部 \\d+\\.\\d+ 引用解析","top_findings":["x"]}';
  assert.deepEqual(parseVerdict(escaped, expect), { score: 8.4, status: 'done', evidence: '全部 \\d+\\.\\d+ 引用解析', findings: ['x'] });
  const placeholders = '{"verificationId":"run-1/designdoc-review/2/1","kind":"designdoc-review","step":2,"attempt":1,'
    + '"score":9,"status":"done","evidence":"记录里的 {{step}}/{{title}} 与 {{artifact}} 都在位"}';
  assert.deepEqual(parseVerdict(placeholders, expect), { score: 9, status: 'done', evidence: '记录里的 {{step}}/{{title}} 与 {{artifact}} 都在位' });
  // Repairing escapes is not a licence to change meaning: a doubled backslash still means one.
  assert.equal(JSON.parse(repairJsonEscapes('{"a":"\\\\d"}')).a, '\\d');
  assert.equal(JSON.parse(repairJsonEscapes('{"a":"x\\ny"}')).a, 'x\ny');
  assert.equal(JSON.parse(repairJsonEscapes('{"a":"\\u4f60"}')).a, '你');
  // A quoted sample of the required shape is not the verdict: the identity still has to match.
  assert.equal(parseVerdict('例如 {"verificationId":"<id>","kind":"k","step":1,"attempt":1}', expect), undefined);
  assert.equal(parseVerdict('结论 "含引号" 的散文，然后是 ' + verdict({ score: 7 }), expect)?.score, 7);
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
  // Without the run's variables the verifier can only infer the subject from the artifact, and an
  // artifact from an earlier run against another document reads as this run's: a live run reviewed
  // the previous document twice while the prompt never named either file.
  assert.doesNotMatch(prompt, /path=/);
  const withVars = verdictBrief({ verificationId: 'run-1/designdoc-review/1/1/1', kind: 'designdoc-review', step: 1, attempt: 1,
    file: '/w/.dsht/verdict.json', artifact: 'DESIGN-DOC-REVIEW.md', vars: { path: 'loop.md' } });
  assert.match(withVars, /本次 run 的记录变量：path=loop\.md/);
  assert.match(withVars, /产出物必须属于这次 run 所指的同一个对象/);
  // Several variables stay one readable line.
  const two = verdictBrief({ verificationId: 'r/k/1/1/1', kind: 'k', step: 1, attempt: 1, file: '/f',
    vars: { path: 'loop.md', scope: 'src' } });
  assert.match(two, /path=loop\.md、scope=src/);
});

test('a forked round tells the agent it is not the scorer, and never promises self-scoring', () => {
  const limits = { from: 1, to: 1, score: 8, tries: 2 };
  const forked = resultContract('designdoc-review', limits, 1, 1, { artifact: 'tui-design.md' }, 'forked').join('\n');
  assert.match(forked, /独立验证进程/);
  assert.match(forked, /不要 spawn 子代理/);
  assert.match(forked, /评分以独立验证为准/);
  assert.doesNotMatch(forked, /以你结尾输出的块为准/);
  // The block the reply parser reads keeps its format wherever the score came from.
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

test('an early stop reaches the port whole, and a broken one reaches it not at all', () => {
  const stop = (extra: Record<string, unknown>): string =>
    JSON.stringify({ verificationId: identity, kind: 'designdoc-review', step: 2, attempt: 1, ...extra });
  assert.deepEqual(parseVerdict(stop({ status: 'blocked', exit_reason: 'cannot-fix', reason: '没有取消端点' }), expect),
    { status: 'blocked', blocked: true, exitReason: 'cannot-fix', reason: '没有取消端点' });
  assert.deepEqual(parseVerdict(stop({ status: 'abstained', reason: '需要人决定', needs: '改哪一侧？' }), expect),
    { status: 'abstained', abstained: true, exitReason: 'needs-human', reason: '需要人决定', needs: '改哪一侧？' });
  // A stop with no reason, one hiding behind a score, or a label that disagrees with its status is
  // no verdict, so the child reports verification unusable instead of letting a bad block end the run.
  for (const broken of [{ status: 'blocked' }, { status: 'blocked', score: 9, reason: 'x' },
    { status: 'abstained', score: 9, reason: 'x' }, { status: 'blocked', exit_reason: 'needs-human', reason: 'x' }]) {
    assert.equal(parseVerdict(stop(broken), expect), undefined);
  }
  // And the brief states the rules the verdict will be read against.
  const prompt = verdictBrief({ ...expect, file: '/w/verdict.json' });
  assert.match(prompt, /提前停下/);
  assert.match(prompt, /abstained/);
  assert.match(prompt, /不许给 score/);
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
