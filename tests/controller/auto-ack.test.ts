/** `/auto-ack`: the numbered menu is answered the way the operator configured it, or not at all. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../../src/controller/controller.ts';
import { readTrace } from '../../src/controller/trace-log.ts';
import { object, type ObjectValue } from '../../src/transport/wire.ts';
import { host, until } from '../support/host.ts';

/** One question waterfall as the host replays it. */
const question = (eventId: string, questions: ObjectValue[]) =>
  ({ type: 'waterfall', event: 'user-questions/request', eventId, agentId: 's1', request: { questions } });

/** The value of the newest interaction reply this client sent. */
function sentReply(fixture: { calls: readonly ObjectValue[] }): unknown {
  const call = fixture.calls.filter(entry => entry.method === '$events/result').at(-1);
  assert.ok(call !== undefined, 'the client sent no interaction reply');
  return object(object(object(call.payload).args).outcome).value;
}

/** Every `auto-ack` event the trace recorded, so "answered automatically" and "not answered" are facts. */
async function autoAckEvents(path: string): Promise<string[]> {
  const events = (await readTrace(path)).filter(line => !line.startsWith('#'))
    .map(line => JSON.parse(line) as { event: string; phase?: string });
  return events.filter(entry => entry.event === 'auto-ack').map(entry => entry.phase ?? '');
}

test('the configured option answers a waiting question and the waterfall that follows it', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.replayInteractions = [question('q1', [
    { id: 'one', question: 'Choose a target', options: [{ label: 'First' }, { label: 'Second' }] },
    { id: 'many', question: 'Choose features', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
  ])];
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await app.stop(); });
  app.actions.setAutoAck(2);
  app.start();
  // Both sub-questions are answered with option 2 and submitted as one reply, exactly as two keypresses
  // and an Enter would have been.
  await until(() => fixture.calls.some(call => call.method === '$events/result'));
  assert.deepEqual(sentReply(fixture), { answers: [
    { id: 'one', selected: ['Second'] }, { id: 'many', selected: ['B'] },
  ] });
  await until(() => app.state.pending.length === 0);
});

test('option 0 turns the policy off, and a later command answers the menu that was waiting', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  fixture.replayInteractions = [question('q1', [
    { id: 'one', question: 'Choose a target', options: [{ label: 'First' }, { label: 'Second' }] },
  ])];
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await app.stop(); });
  app.actions.setAutoAck(0);
  app.start();
  await until(() => app.state.pending.length === 1);
  // Off means off: the menu is still the operator's to answer, so nothing was sent.
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
  assert.equal(app.state.autoAck, undefined);
  // Turning it on applies to the menu already on screen, not only to the next one.
  app.actions.setAutoAck(1);
  await until(() => fixture.calls.some(call => call.method === '$events/result'));
  assert.deepEqual(sentReply(fixture), { answers: [{ id: 'one', selected: ['First'] }] });
});

test('an option the menu does not offer is left to the operator instead of guessed at', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsht-auto-ack-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'trace.log');
  const fixture = await host(); t.after(() => fixture.close());
  fixture.replayInteractions = [question('q1', [
    { id: 'one', question: 'Choose a target', options: [{ label: 'First' }, { label: 'Second' }] },
  ])];
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1', tracePath: path });
  t.after(async () => { await app.stop(); });
  app.actions.setAutoAck(5);
  app.start();
  await until(() => app.state.pending.length === 1);
  await app.trace?.settle();
  // Option 5 names no row, so the policy declined this position rather than typing a free-text answer.
  assert.deepEqual(await autoAckEvents(path), []);
  assert.equal(fixture.calls.some(call => call.method === '$events/result'), false);
  // The operator's own answer still settles it, and that answer is the one the host receives.
  assert.equal(await app.actions.answerQuestion({ selected: ['Second'] }), true);
  await until(() => fixture.calls.some(call => call.method === '$events/result'));
  assert.deepEqual(sentReply(fixture), { answers: [{ id: 'one', selected: ['Second'] }] });
});

test('an approval is answered by its number, and 3 stops the turn instead of replying', async t => {
  const fixture = await host(); t.after(() => fixture.close());
  const app = new Controller({ base: fixture.url, token: 'fixture-token', initialSession: 's1' });
  t.after(async () => { await app.stop(); });
  app.actions.setAutoAck(1);
  app.start();
  await until(() => app.queries.record.ready);
  const ask = (eventId: string) => app.event({ kind: 'approval-request', eventId, sessionId: 's1', description: 'Run the command' });
  // 1 is `Allow once`: the host receives the same result the operator's key would have sent.
  ask('a1');
  await until(() => fixture.calls.some(call => call.method === '$events/result'));
  const approval = object(object(fixture.calls.filter(call => call.method === '$events/result').at(-1)!.payload).args);
  assert.equal(object(approval.outcome).value, 'allowed-once');
  await until(() => app.state.pending.length === 0);
  // 3 is `Stop turn`: like the key, it cancels the turn instead of answering the request, so the
  // approval stays pending until the host cancels that waterfall itself.
  const results = fixture.calls.filter(call => call.method === '$events/result').length;
  app.actions.setAutoAck(3);
  ask('a2');
  await until(() => fixture.calls.some(call => call.method === 'session/cancel'));
  assert.equal(app.state.pending.length, 1);
  assert.equal(fixture.calls.filter(call => call.method === '$events/result').length, results);
});
