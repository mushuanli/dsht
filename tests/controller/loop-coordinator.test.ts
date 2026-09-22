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
const limits = { from: 1, to: 2, score: 8, tries: 2 };

function harness() {
  const facts = { sessionId: 's1', online: true, ready: true, busy: false, pending: false };
  const sent: string[] = [];
  const errors: string[] = [];
  const events: ObjectValue[] = [];
  const host: LoopHost = {
    facts: () => facts, reply: () => '',
    send: async text => { sent.push(text); },
    publish: failure => { if (failure !== undefined) errors.push(failure); },
    trace: (event, detail) => { events.push({ event, ...detail }); },
  };
  return { host, facts, sent, errors, events };
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
