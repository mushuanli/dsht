/** The generic scored loop: defaults, the reply contract, and the step machine every protocol reuses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScoredLoop, latestAssistantText, parseLoopScore, resolveLoop, type LoopProtocol } from '../../src/controller/loop.ts';

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

test('the score is read only from the last block of the declared marker and kind', () => {
  const block = (marker: string, body: string) => '```' + marker + '\n' + body + '\n```';
  const reply = [
    'finding: something',
    block('dsht-loop', '{"kind":"demo","score":6}'),
    'more prose',
    block('dsht-loop', '{"kind":"demo","score":8.5}'),
  ].join('\n');
  assert.equal(parseLoopScore(reply, PROTOCOL), 8.5);
  // A numeric string is accepted; a wrong kind, wrong marker, bad JSON or out-of-range score is not.
  assert.equal(parseLoopScore(block('dsht-loop', '{"kind":"demo","score":"9.5"}'), PROTOCOL), 9.5);
  assert.equal(parseLoopScore(block('dsht-loop', '{"kind":"other","score":9}'), PROTOCOL), undefined);
  assert.equal(parseLoopScore(block('other', '{"kind":"demo","score":9}'), PROTOCOL), undefined);
  assert.equal(parseLoopScore(block('dsht-loop', '{not json}'), PROTOCOL), undefined);
  assert.equal(parseLoopScore(block('dsht-loop', '{"kind":"demo","score":11}'), PROTOCOL), undefined);
  assert.equal(parseLoopScore('no block here', PROTOCOL), undefined);
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
  const retry = loop.settle(7);
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
  assert.equal(loop.settle(8).kind, 'continue');
  assert.equal(loop.progress.step, 2);
  assert.equal(loop.progress.attempt, 1);
  assert.equal(loop.progress.best, 0);
  assert.equal(loop.settle(9.5).kind, 'passed');
  assert.equal(loop.progress.phase, 'passed');
});

test('cancelling ends the loop and it never continues', () => {
  const loop = new ScoredLoop('s1', PROTOCOL, { from: 1, to: 10, score: 8, tries: 10 });
  loop.cancel();
  assert.equal(loop.active, false);
  assert.equal(loop.settled, false);
  assert.equal(loop.progress.phase, 'cancelled');
});
