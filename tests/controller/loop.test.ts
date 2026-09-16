/** The generic scored loop: defaults, the reply contract, and the step machine every protocol reuses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScoredLoop, latestAssistantText, parseLoopResult, readResultFields, resolveLoop, type LoopProtocol } from '../../src/controller/loop.ts';
/** A minimal protocol: enough to exercise the mechanism without any real prompt text. */
const PROTOCOL: LoopProtocol = {
  marker: 'dsht-loop', kind: 'demo', title: 'Demo', steps: 10,
  brief: (limits, step, attempt) => `brief ${step}/${attempt} of ${limits.from}-${limits.to} pass ${limits.score} tries ${limits.tries}`,
  followUp: (_limits, step, attempt) => `follow ${step}/${attempt}`,
};
test('the defaults come from the protocol and a reversed range is refused', () => {
  assert.deepEqual(resolveLoop(PROTOCOL, {}), { from: 1, to: 10, score: 8, tries: 10 });
  assert.deepEqual(resolveLoop(PROTOCOL, { from: 3, to: 5, score: 8.5, tries: 4 }), { from: 3, to: 5, score: 8.5, tries: 4 });
  // A protocol may choose its own defaults for the two values that are not its step count.
  assert.deepEqual(resolveLoop({ ...PROTOCOL, defaultScore: 9, defaultTries: 3 }, {}), { from: 1, to: 10, score: 9, tries: 3 });
  assert.equal(resolveLoop(PROTOCOL, { from: 5, to: 1 }), undefined);
});
test('the result is read only from the last block of the declared marker and kind', () => {
  const block = (marker: string, body: string) => '```' + marker + '\n' + body + '\n```';
  const reply = [
    'finding: something',
    block('dsht-loop', '{"kind":"demo","score":6,"status":"retry"}'),
    'more prose',
    block('dsht-loop', '{"kind":"demo","score":8.5,"status":"done"}'),
  ].join('\n');
  assert.deepEqual(parseLoopResult(reply, PROTOCOL), { score: 8.5, status: 'done' });
  // A numeric string is accepted; an unknown status is dropped rather than guessed.
  assert.deepEqual(parseLoopResult(block('dsht-loop', '{"kind":"demo","score":"9.5","status":"weird"}'), PROTOCOL), { score: 9.5 });
  // A verifier may report blocked with no score at all; that still ends the run.
  assert.deepEqual(parseLoopResult(block('dsht-loop', '{"kind":"demo","status":"blocked"}'), PROTOCOL), { status: 'blocked', blocked: true });
  // A wrong kind, wrong marker, bad JSON or out-of-range score yields no result.
  assert.equal(parseLoopResult(block('dsht-loop', '{"kind":"other","score":9}'), PROTOCOL), undefined);
  assert.equal(parseLoopResult(block('other', '{"kind":"demo","score":9}'), PROTOCOL), undefined);
  assert.equal(parseLoopResult(block('dsht-loop', '{not json}'), PROTOCOL), undefined);
  assert.deepEqual(parseLoopResult(block('dsht-loop', '{"kind":"demo","score":11}'), PROTOCOL), {});
  assert.equal(parseLoopResult('no block here', PROTOCOL), undefined);
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
test('a step retries below the score, advances at it, and stops when the budget runs out', () => {
  const loop = new ScoredLoop('s1', PROTOCOL, { from: 1, to: 2, score: 8, tries: 2 });
  assert.deepEqual(loop.progress, { title: 'Demo', from: 1, to: 2, score: 8, tries: 2, step: 1, attempt: 1, best: 0, phase: 'running' });
  assert.equal(loop.start(), 'brief 1/1 of 1-2 pass 8 tries 2');
  loop.sent();
  assert.equal(loop.settled, true);
  // A low score costs one attempt; the next one exhausts the budget.
  const retry = loop.settle({ score: 7 });
  assert.equal(retry.kind, 'continue');
  assert.equal(retry.kind === 'continue' && retry.prompt, 'follow 1/2');
  assert.equal(loop.settled, false);
  assert.equal(loop.settle(undefined).kind, 'exhausted');
  assert.equal(loop.progress.phase, 'exhausted');
  assert.equal(loop.progress.best, 7);
  assert.equal(loop.active, false);
});
test('reaching the score advances one step and the last step finishes the run', () => {
  const loop = new ScoredLoop('s1', PROTOCOL, { from: 1, to: 2, score: 8, tries: 3 });
  assert.equal(loop.settle({ score: 8 }).kind, 'continue');
  assert.equal(loop.progress.step, 2);
  assert.equal(loop.progress.attempt, 1);
  assert.equal(loop.progress.best, 0);
  assert.equal(loop.settle({ score: 9.5 }).kind, 'passed');
  assert.equal(loop.progress.phase, 'passed');
});
test('cancelling ends the loop and it never continues', () => {
  const loop = new ScoredLoop('s1', PROTOCOL, { from: 1, to: 10, score: 8, tries: 10 });
  loop.cancel();
  assert.equal(loop.active, false);
  assert.equal(loop.settled, false);
  assert.equal(loop.progress.phase, 'cancelled');
});
test('a blocked verdict ends the run instead of spending the remaining budget', () => {
  const loop = new ScoredLoop('s1', PROTOCOL, { from: 1, to: 10, score: 8, tries: 10 });
  assert.equal(loop.settle({ status: 'blocked' }).kind, 'blocked');
  assert.equal(loop.progress.phase, 'blocked');
  assert.equal(loop.active, false);
});
test('a protocol that names its steps shows that name in the progress snapshot', () => {
  const labelled = { ...PROTOCOL, stepLabel: (step: number) => `phase ${step}` };
  const loop = new ScoredLoop('s1', labelled, { from: 2, to: 3, score: 8, tries: 2 });
  assert.equal(loop.progress.stepLabel, 'phase 2');
  assert.equal(loop.settle({ score: 9 }).kind, 'continue');
  assert.equal(loop.progress.stepLabel, 'phase 3');
  // A protocol without labels keeps the field absent, so the UI shows no separator.
  assert.equal(new ScoredLoop('s1', PROTOCOL, { from: 1, to: 1, score: 8, tries: 1 }).progress.stepLabel, undefined);
});
test('a verdict keeps the findings and evidence a retry needs, bounded', () => {
  assert.deepEqual(readResultFields({ score: '4.5', status: 'retry', evidence: 'ran the checks',
    top_findings: ['A 未解决', 42, '  ', 'B 未解决'] }),
  { score: 4.5, status: 'retry', evidence: 'ran the checks', findings: ['A 未解决', 'B 未解决'] });
  // Untrusted model output is bounded before it is echoed into a prompt.
  const many = readResultFields({ score: 1, top_findings: Array.from({ length: 20 }, (_, index) => `f${index}`) });
  assert.equal(many.findings?.length, 8);
  assert.ok((readResultFields({ score: 1, top_findings: ['x'.repeat(500)] }).findings?.[0] ?? '').length <= 300);
});
test('a plateau is tolerated once, and a second one stalls the run', () => {
  const protocol = { marker: 'm', kind: 'k', title: 'T', steps: 2, brief: () => 'brief', followUp: () => 'again' };
  const loop = new ScoredLoop('s1', protocol, { from: 1, to: 2, score: 8, tries: 8 });
  loop.start(); loop.sent();
  // The first attempt may score anything, including an unusable verdict, without stalling.
  assert.equal(loop.settle({}).kind, 'continue');
  loop.sent(); assert.equal(loop.settle({ score: 4 }).kind, 'continue');
  loop.sent(); assert.equal(loop.settle({ score: 4 }).kind, 'continue');   // one plateau is jitter
  loop.sent(); assert.equal(loop.settle({ score: 6 }).kind, 'continue');  // an improvement resets it
  loop.sent(); assert.equal(loop.settle({ score: 6 }).kind, 'continue');
  loop.sent(); assert.equal(loop.settle({ score: 5 }).kind, 'stalled');   // a decrease counts too
  assert.equal(loop.progress.phase, 'stalled');
  assert.equal(loop.active, false);
});

test('a step that keeps improving is allowed to spend its whole budget', () => {
  const protocol = { marker: 'm', kind: 'k', title: 'T', steps: 2, brief: () => 'brief', followUp: () => 'again' };
  const loop = new ScoredLoop('s1', protocol, { from: 1, to: 2, score: 8, tries: 3 });
  loop.start(); loop.sent();
  assert.equal(loop.settle({ score: 1 }).kind, 'continue');
  loop.sent(); assert.equal(loop.settle({ score: 2 }).kind, 'continue');
  loop.sent();
  // Improving every time but never passing ends as a spent budget, not as a stall.
  assert.equal(loop.settle({ score: 3 }).kind, 'exhausted');
  assert.equal(loop.progress.phase, 'exhausted');
});

test('the score decides, and only a blocked verdict overrides it', () => {
  assert.deepEqual(readResultFields({ score: 9, status: 'retry' }), { score: 9, status: 'retry' });
  assert.deepEqual(readResultFields({ score: 3, status: 'done' }), { score: 3, status: 'done' });
  // A verifier that proved the task impossible overrides the score, however it said so.
  assert.deepEqual(readResultFields({ score: 9, blocked: true }), { score: 9, blocked: true });
  assert.deepEqual(readResultFields({ status: 'blocked' }), { status: 'blocked', blocked: true });

  const protocol = { marker: 'm', kind: 'k', title: 'T', steps: 2, brief: () => 'b', followUp: () => 'a' };
  const limits = { from: 1, to: 2, score: 8, tries: 2 };
  // `status: retry` with a passing score advances: the model does not get to veto its own score.
  const passing = new ScoredLoop('s1', protocol, limits);
  passing.start(); passing.sent();
  assert.equal(passing.settle(readResultFields({ score: 9, status: 'retry' })).kind, 'continue');
  // `status: done` below the threshold still costs an attempt.
  const failing = new ScoredLoop('s1', protocol, limits);
  failing.start(); failing.sent();
  assert.equal(failing.settle(readResultFields({ score: 3, status: 'done' })).kind, 'continue');
  assert.equal(failing.progress.attempt, 2);
  // A blocked verdict ends the run at any score.
  const blocked = new ScoredLoop('s1', protocol, limits);
  blocked.start(); blocked.sent();
  assert.equal(blocked.settle(readResultFields({ score: 9, status: 'blocked' })).kind, 'blocked');
  assert.equal(blocked.progress.phase, 'blocked');
});
