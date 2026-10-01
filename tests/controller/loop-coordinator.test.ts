/** Run ownership at asynchronous boundaries, without an application controller or wire client. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopHost } from '../../src/controller/loop-coordinator.ts';
import type { LoopProtocol } from '../../src/controller/loop.ts';
import type { ObjectValue } from '../../src/json.ts';
import { until } from '../support/host.ts';

const protocol: LoopProtocol = {
  kind: 'fixture', title: 'Fixture', marker: 'dsht-loop', steps: 2,
  brief: () => 'begin', followUp: () => 'continue', verify: () => 'judge',
};
const limits = { from: 1, to: 2, score: 8, tries: 2, autoCompactK: 0 };

function harness() {
  const facts = { sessionId: 's1', online: true, ready: true, busy: false, pending: false };
  const sent: string[] = [];
  const errors: string[] = [];
  const events: ObjectValue[] = [];
  /** Auto-compactions the run asked for, as what had already been sent when each one started. */
  const compacts: number[] = [];
  /** What this host projects for the session's next request; undefined until a test reports one. */
  const context: { tokens: number | undefined } = { tokens: undefined };
  const host: LoopHost = {
    facts: () => facts, reply: () => '',
    send: async text => { sent.push(text); },
    historyTokens: () => context.tokens,
    // A real host republishes a smaller context once it has compacted; one that did not would simply
    // be asked again, which is the run obeying the number it was given.
    compact: async () => { compacts.push(sent.length); context.tokens = 1_000; return 'Command completed.'; },
    publish: failure => { if (failure !== undefined) errors.push(failure); },
    trace: (event, detail) => { events.push({ event, ...detail }); },
  };
  return { host, facts, sent, errors, events, compacts, context };
}

test('a rejected send from a replaced run does not stop or report failure on the new run', async t => {
  const { host, sent, errors, events } = harness();
  let reject!: (error: Error) => void;
  host.send = text => {
    sent.push(text);
    return sent.length === 1 ? new Promise<void>((_resolve, fail) => { reject = fail; }) : Promise.resolve();
  };
  const coordinator = new LoopCoordinator(host, { directory: '/fixture' });
  t.after(() => coordinator.close());
  const first = coordinator.start(protocol, limits);
  const rejected = assert.rejects(first, /old request failed/);
  await coordinator.start(protocol, limits);
  const current = coordinator.progress!.runId;
  reject(new Error('old request failed'));
  await rejected;
  assert.equal(coordinator.progress?.runId, current);
  assert.equal(coordinator.progress?.active, true);
  assert.deepEqual(errors, []);
  assert.equal(events.filter(event => event.event === 'loop' && event.phase === 'end').length, 1);
});

test('a next step waits for the restored session snapshot and is sent exactly once', async t => {
  const { host, facts, sent } = harness();
  const coordinator = new LoopCoordinator(host, { directory: '/fixture', verifier: {
    name: 'fixture', verify: async () => ({ type: 'verified', result: { score: 9 }, sessionId: 'v1' }),
  } });
  t.after(() => coordinator.close());
  host.publish = () => coordinator.changed();
  await coordinator.start(protocol, limits);
  facts.ready = false;
  coordinator.idle('s1');
  await until(() => coordinator.progress?.step === 2);
  assert.equal(sent.length, 1);
  coordinator.changed();
  assert.equal(sent.length, 1);
  facts.ready = true;
  coordinator.changed();
  coordinator.changed();
  assert.deepEqual(sent, ['begin', 'continue']);
});

test('a run that set an auto-compact threshold compacts before the round that crosses it', async t => {
  const { host, sent, compacts, context } = harness();
  const coordinator = new LoopCoordinator(host, { directory: '/fixture', verifier: {
    name: 'fixture', verify: async () => ({ type: 'verified', result: { score: 9 }, sessionId: 'v1' }),
  } });
  t.after(() => coordinator.close());
  host.publish = () => coordinator.changed();
  await coordinator.start(protocol, { ...limits, autoCompactK: 100 });
  // No host metric: the run cannot judge a history nobody reported, so it sends as usual.
  coordinator.idle('s1');
  await until(() => sent.length === 2);
  assert.deepEqual(compacts, [], 'an unmeasured history is not a history over the limit');
});

test('a history under the threshold is sent without a compaction', async t => {
  const { host, sent, compacts, context } = harness();
  const coordinator = new LoopCoordinator(host, { directory: '/fixture', verifier: {
    name: 'fixture', verify: async () => ({ type: 'verified', result: { score: 9 }, sessionId: 'v1' }),
  } });
  t.after(() => coordinator.close());
  host.publish = () => coordinator.changed();
  context.tokens = 99_000;
  await coordinator.start(protocol, { ...limits, autoCompactK: 100 });
  coordinator.idle('s1');
  await until(() => sent.length === 2);
  assert.deepEqual(compacts, [], 'a history under the threshold is left alone');
});

test('a history over the threshold is compacted before the next round goes out', async t => {
  const { host, sent, compacts, context } = harness();
  const coordinator = new LoopCoordinator(host, { directory: '/fixture', verifier: {
    name: 'fixture', verify: async () => ({ type: 'verified', result: { score: 9 }, sessionId: 'v1' }),
  } });
  t.after(() => coordinator.close());
  host.publish = () => coordinator.changed();
  context.tokens = 150_000;
  await coordinator.start(protocol, { ...limits, autoCompactK: 100 });
  // The threshold was already exceeded before the first prompt, so the run compacted before sending
  // it: the compaction is recorded when nothing had been sent, and it says how big the history was.
  assert.deepEqual(compacts, [0]);
  assert.match(coordinator.progress?.note ?? '', /auto compact · 150K tokens · Command completed\./);
  coordinator.idle('s1');
  await until(() => sent.length === 2);
  // The host now reports a compacted history, so the next round goes out without a second compaction.
  assert.deepEqual(sent, ['begin', 'continue']);
  assert.deepEqual(compacts, [0]);
});

test('a compaction that fails is a note, and the round is still sent', async t => {
  const { host, sent, context } = harness();
  const coordinator = new LoopCoordinator(host, { directory: '/fixture', verifier: {
    name: 'fixture', verify: async () => ({ type: 'verified', result: { score: 9 }, sessionId: 'v1' }),
  } });
  t.after(() => coordinator.close());
  host.publish = () => coordinator.changed();
  host.compact = async () => { throw new Error('the host refused to compact'); };
  context.tokens = 50_000;
  await coordinator.start(protocol, { ...limits, autoCompactK: 10 });
  coordinator.idle('s1');
  await until(() => sent.length === 2);
  assert.match(coordinator.progress?.note ?? '', /auto compact failed · the host refused to compact/);
  assert.equal(coordinator.progress?.active, true);
});

test('a stop during the verifying notification prevents the verifier from starting', async () => {
  const { host } = harness();
  let called = false;
  const coordinator = new LoopCoordinator(host, { directory: '/fixture', verifier: {
    name: 'fixture', verify: async () => { called = true; return { type: 'cancelled' }; },
  } });
  host.publish = () => { if (coordinator.progress?.activity === 'verify') coordinator.stop(); };
  await coordinator.start({ ...protocol, starts: 'verify' }, limits);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(called, false);
  assert.equal(coordinator.progress?.phase, 'cancelled');
  await coordinator.close();
});

test('an unreadable artifact reports the boundary and settles without an unhandled rejection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-artifact-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Reading a directory as UTF-8 fails deterministically, including when tests run as root.
  await mkdir(join(directory, 'review.md'));
  const { host } = harness();
  const coordinator = new LoopCoordinator(host, { directory, verifier: {
    name: 'fixture', verify: async () => ({ type: 'verified', result: { score: 9 }, sessionId: 'v1' }),
  } });
  t.after(() => coordinator.close());
  await coordinator.start({ ...protocol, artifact: 'review.md', artifactMarker: () => '## Round' }, { ...limits, to: 1 });
  coordinator.idle('s1');
  await until(() => coordinator.progress?.phase === 'passed');
  assert.match(coordinator.progress?.note ?? '', /artifact check unavailable/);
  await coordinator.close();
  assert.equal(coordinator.progress?.phase, 'passed', 'closing must not rewrite a terminal verdict as cancellation');
  await assert.rejects(coordinator.start(protocol, limits), /Client stopped/);
});

for (const artifact of ['missing.md', 'missing/review.md']) test(`a missing visible artifact ${artifact} cannot pass on a verifier score`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-missing-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { host, sent } = harness();
  const coordinator = new LoopCoordinator(host, { directory, verifier: {
    name: 'fixture', verify: async () => ({ type: 'verified', result: { score: 10 }, sessionId: 'v1' }),
  } });
  t.after(() => coordinator.close());
  await coordinator.start({ ...protocol, artifact, artifactMarker: () => '## Round' }, { ...limits, to: 1 });
  coordinator.idle('s1');
  await until(() => coordinator.progress?.phase === 'passed' || sent.length === 2);
  assert.notEqual(coordinator.progress?.phase, 'passed');
  assert.equal(coordinator.progress?.attempt, 2);
  assert.match(sent[1]!, /缺少本轮小节/);
});
